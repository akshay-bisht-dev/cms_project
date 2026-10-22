import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { isoDate } from '../../utils/time.js';
import { moneyString } from './money.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

const RECEIPT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** Expenses an approver may decide: org-wide, or those on projects they manage (never their own). */
async function approvableWhere(db, ctx) {
  if (hasOrgScope(ctx, 'finance.expenses.approve')) return { organizationId: ctx.orgId, userId: { not: ctx.userId } };
  if (!hasPermission(ctx, 'finance.expenses.approve')) return { organizationId: ctx.orgId, id: '__none__' };
  const projects = await db.project.findMany({ where: { organizationId: ctx.orgId, OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] }, select: { id: true } });
  return { organizationId: ctx.orgId, userId: { not: ctx.userId }, projectId: { in: projects.map((p) => p.id) } };
}

export function createExpenseService({ prisma, clock, cipher, env, fileService }) {
  async function serialize(db, ctx, rows) {
    const people = await memberSummaries(db, ctx.orgId, rows.flatMap((r) => [r.userId, r.decidedById]));
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter(Boolean))];
    const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean))];
    const [projects, clients, invoiced] = await Promise.all([
      projectIds.length ? db.project.findMany({ where: { organizationId: ctx.orgId, id: { in: projectIds } }, select: { id: true, code: true, name: true } }) : [],
      clientIds.length ? db.client.findMany({ where: { organizationId: ctx.orgId, id: { in: clientIds } }, select: { id: true, name: true } }) : [],
      db.invoiceItemExpense.findMany({ where: { organizationId: ctx.orgId, expenseId: { in: rows.map((r) => r.id) } }, select: { expenseId: true } }),
    ]);
    const p = new Map(projects.map((x) => [x.id, x]));
    const c = new Map(clients.map((x) => [x.id, x]));
    const billed = new Set(invoiced.map((i) => i.expenseId));
    return rows.map((e) => ({
      id: e.id,
      employee: people.get(e.userId) ? { id: people.get(e.userId).employeeId, name: people.get(e.userId).name } : null,
      description: e.description,
      amount: moneyString(e.amount, e.currency),
      currency: e.currency,
      incurredOn: isoDate(e.incurredOn),
      isBillable: e.isBillable,
      category: e.category ? { id: e.category.id, name: e.category.name } : null,
      project: p.get(e.projectId) ?? null,
      client: c.get(e.clientId) ?? null,
      hasReceipt: Boolean(e.receiptFileId),
      status: e.status,
      submittedAt: e.submittedAt,
      decidedAt: e.decidedAt,
      decidedBy: e.decidedById ? { name: people.get(e.decidedById)?.name ?? 'Former member' } : null,
      decisionComment: e.decisionComment,
      reimbursedAt: e.reimbursedAt,
      invoiced: billed.has(e.id),
      own: e.userId === ctx.userId,
      version: e.version,
    }));
  }

  async function validateRefs(db, ctx, { projectId, clientId, categoryId, receiptFileId }) {
    if (projectId) {
      const project = await db.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId } });
      if (!project) throw new ValidationError([{ path: 'body.projectId', message: 'Project not found' }]);
      if (clientId && project.clientId && project.clientId !== clientId) throw new ValidationError([{ path: 'body.clientId', message: 'The project belongs to another client' }]);
    }
    if (clientId && !(await db.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } }))) throw new ValidationError([{ path: 'body.clientId', message: 'Client not found' }]);
    if (categoryId && !(await db.expenseCategory.findFirst({ where: { organizationId: ctx.orgId, id: categoryId, archivedAt: null } }))) throw new ValidationError([{ path: 'body.categoryId', message: 'Category not found' }]);
    if (receiptFileId) {
      const file = await db.fileObject.findFirst({ where: { organizationId: ctx.orgId, id: receiptFileId, purpose: 'receipt', uploadedById: ctx.userId, status: 'READY' } });
      if (!file) throw new ValidationError([{ path: 'body.receiptFileId', message: 'Upload the receipt first' }]);
    }
  }

  async function loadOwn(db, ctx, expenseId) {
    const e = await db.expense.findFirst({ where: { organizationId: ctx.orgId, id: expenseId, userId: ctx.userId }, include: { category: true } });
    if (!e) throw new NotFoundError('Expense not found');
    return e;
  }

  async function loadVisible(db, ctx, expenseId) {
    const e = await db.expense.findFirst({ where: { organizationId: ctx.orgId, id: expenseId }, include: { category: true } });
    if (!e) throw new NotFoundError('Expense not found');
    if (e.userId === ctx.userId || hasPermission(ctx, 'finance.invoices.manage')) return e;
    if (await db.expense.findFirst({ where: { AND: [await approvableWhere(db, ctx), { id: e.id }] }, select: { id: true } })) return e;
    throw new NotFoundError('Expense not found');
  }

  return {
    approvableWhere,

    async list(ctx, { view = 'mine', status, projectId, clientId, billable }) {
      let where;
      if (view === 'mine') where = { organizationId: ctx.orgId, userId: ctx.userId };
      else if (view === 'approvals') where = { AND: [await approvableWhere(prisma, ctx), { status: 'SUBMITTED' }] };
      else {
        if (!hasPermission(ctx, 'finance.invoices.manage')) throw new ForbiddenError('You cannot view all expenses');
        where = { organizationId: ctx.orgId };
      }
      const filters = [where];
      if (status) filters.push({ status: { in: status } });
      if (projectId) filters.push({ projectId });
      if (clientId) filters.push({ clientId });
      if (billable !== undefined) filters.push({ isBillable: billable });
      const rows = await prisma.expense.findMany({ where: { AND: filters }, include: { category: true }, orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }], take: 500 });
      return serialize(prisma, ctx, rows);
    },

    async presignReceipt(ctx, { fileName, contentType, sizeBytes }) {
      if (!RECEIPT_TYPES.has(contentType)) throw new ValidationError([{ path: 'body.contentType', message: 'Receipts must be PDF or an image' }]);
      if (sizeBytes > MAX_RECEIPT_BYTES) throw new ValidationError([{ path: 'body.sizeBytes', message: 'Receipts must be 10 MB or smaller' }]);
      const { file, upload } = await fileService.presignUpload(prisma, ctx, { purpose: 'receipt', fileName, contentType, sizeBytes });
      return { fileId: file.id, upload };
    },

    async confirmReceipt(ctx, fileId) {
      return fileService.serialize(await fileService.verifyUpload(prisma, ctx, fileId));
    },

    async receiptUrl(ctx, expenseId) {
      const e = await loadVisible(prisma, ctx, expenseId);
      if (!e.receiptFileId) throw new NotFoundError('No receipt');
      const file = await prisma.fileObject.findFirst({ where: { organizationId: ctx.orgId, id: e.receiptFileId } });
      return fileService.accessUrl(file);
    },

    async create(ctx, body) {
      await validateRefs(prisma, ctx, body);
      const e = await prisma.expense.create({
        data: { organizationId: ctx.orgId, userId: ctx.userId, ...body, clientId: body.clientId ?? (body.projectId ? (await prisma.project.findFirst({ where: { organizationId: ctx.orgId, id: body.projectId } })).clientId : null), incurredOn: new Date(`${body.incurredOn}T00:00:00Z`) },
        include: { category: true },
      });
      return (await serialize(prisma, ctx, [e]))[0];
    },

    async update(ctx, expenseId, { version, ...patch }) {
      return withTransaction(prisma, async (tx) => {
        const e = await loadOwn(tx, ctx, expenseId);
        if (!['DRAFT', 'REJECTED'].includes(e.status)) throw new ConflictError('Only draft or rejected expenses can be edited', ERROR_CODES.INVALID_STATE_TRANSITION);
        if (version !== undefined && version !== e.version) throw new ConflictError('This expense changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        await validateRefs(tx, ctx, { ...patch, clientId: patch.clientId ?? e.clientId });
        const updated = await tx.expense.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: e.id } },
          data: { ...patch, ...(patch.incurredOn ? { incurredOn: new Date(`${patch.incurredOn}T00:00:00Z`) } : {}), status: 'DRAFT', version: { increment: 1 } },
          include: { category: true },
        });
        return (await serialize(tx, ctx, [updated]))[0];
      });
    },

    async remove(ctx, expenseId) {
      const e = await loadOwn(prisma, ctx, expenseId);
      if (!['DRAFT', 'REJECTED'].includes(e.status)) throw new ConflictError('Submitted expenses cannot be deleted', ERROR_CODES.INVALID_STATE_TRANSITION);
      await prisma.expense.deleteMany({ where: { organizationId: ctx.orgId, id: e.id } });
    },

    async submit(ctx, expenseId) {
      return withTransaction(prisma, async (tx) => {
        const e = await loadOwn(tx, ctx, expenseId);
        const { count } = await tx.expense.updateMany({ where: { organizationId: ctx.orgId, id: e.id, status: { in: ['DRAFT', 'REJECTED'] } }, data: { status: 'SUBMITTED', submittedAt: clock.now(), decidedAt: null, decidedById: null, decisionComment: null, version: { increment: 1 } } });
        if (!count) throw new ConflictError(`A ${e.status.toLowerCase()} expense cannot be submitted`, ERROR_CODES.INVALID_STATE_TRANSITION);
        await recordAudit(tx, ctx, { action: 'expenses.submitted', targetType: 'expense', targetId: e.id, diff: { amount: String(e.amount), currency: e.currency } });
        return (await serialize(tx, ctx, [await loadOwn(tx, ctx, e.id)]))[0];
      });
    },

    async decide(ctx, expenseId, { decision, comment }) {
      if (decision === 'REJECTED' && !comment) throw new ValidationError([{ path: 'body.comment', message: 'Say why the expense was rejected' }]);
      return withTransaction(prisma, async (tx) => {
        const e = await tx.expense.findFirst({ where: { AND: [await approvableWhere(tx, ctx), { id: expenseId }] }, include: { category: true } });
        if (!e) {
          const own = await tx.expense.findFirst({ where: { organizationId: ctx.orgId, id: expenseId, userId: ctx.userId } });
          throw own ? new ForbiddenError('You cannot approve your own expense') : new NotFoundError('Expense not found');
        }
        const { count } = await tx.expense.updateMany({
          where: { organizationId: ctx.orgId, id: e.id, status: 'SUBMITTED' },
          data: { status: decision, decidedAt: clock.now(), decidedById: ctx.userId, decisionComment: comment ?? null, version: { increment: 1 } },
        });
        if (!count) throw new ConflictError(`A ${e.status.toLowerCase()} expense cannot be ${decision.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        await recordAudit(tx, ctx, { action: `expenses.${decision.toLowerCase()}`, targetType: 'expense', targetId: e.id, diff: { comment } });
        if (decision === 'APPROVED') await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'expense.approved', data: { expenseId: e.id, amount: e.amount.toFixed(2), currency: e.currency } });
        await notify(tx, ctx, {
          cipher,
          appOrigin: env.APP_ORIGIN,
          organizationId: ctx.orgId,
          recipientUserId: e.userId,
          type: 'expenses.decided',
          title: `Your expense "${e.description}" was ${decision.toLowerCase()}`,
          body: comment ?? null,
          link: '/expenses',
          subjectType: 'expense',
          subjectId: e.id,
          dedupeKey: `expense-decided:${e.id}:${e.version + 1}`,
        });
        return (await serialize(tx, ctx, [await tx.expense.findFirst({ where: { organizationId: ctx.orgId, id: e.id }, include: { category: true } })]))[0];
      });
    },

    async reimburse(ctx, expenseId) {
      const e = await prisma.expense.findFirst({ where: { organizationId: ctx.orgId, id: expenseId } });
      if (!e) throw new NotFoundError('Expense not found');
      const { count } = await prisma.expense.updateMany({ where: { organizationId: ctx.orgId, id: e.id, status: 'APPROVED' }, data: { status: 'REIMBURSED', reimbursedAt: clock.now(), version: { increment: 1 } } });
      if (!count) throw new BusinessRuleError('Only approved expenses can be reimbursed', ERROR_CODES.INVALID_STATE_TRANSITION);
      await recordAudit(prisma, ctx, { action: 'expenses.reimbursed', targetType: 'expense', targetId: e.id });
    },
  };
}
