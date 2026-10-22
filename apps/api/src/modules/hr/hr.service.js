import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { dateOnly, isoDate, localDate } from '../../utils/time.js';
import { coversMember, hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { employeeCreatedHooks, offboardingHooks } from '../employees/employees.service.js';

export const DOCUMENT_TYPES = ['CONTRACT', 'OFFER_LETTER', 'ID_PROOF', 'TAX', 'CERTIFICATE', 'POLICY_ACK', 'PERFORMANCE', 'OTHER'];
const DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const DEFAULT_TEMPLATES = [
  {
    kind: 'ONBOARDING',
    name: 'Standard onboarding',
    items: [
      { title: 'Sign the employment contract', assignee: 'HR', dueOffsetDays: 0 },
      { title: 'Set up laptop and accounts', assignee: 'MANAGER', dueOffsetDays: 0 },
      { title: 'Complete your profile', assignee: 'EMPLOYEE', dueOffsetDays: 3 },
      { title: 'Introduce the team and first tasks', assignee: 'MANAGER', dueOffsetDays: 5 },
    ],
  },
  {
    kind: 'OFFBOARDING',
    name: 'Standard offboarding',
    items: [
      { title: 'Collect equipment', assignee: 'MANAGER', dueOffsetDays: 0 },
      { title: 'Confirm system access is removed', assignee: 'HR', dueOffsetDays: 0 },
      { title: 'Exit interview', assignee: 'HR', dueOffsetDays: 1 },
      { title: 'Final settlement', assignee: 'HR', dueOffsetDays: 7 },
    ],
  },
];

async function ensureTemplates(db, organizationId) {
  if (await db.checklistTemplate.count({ where: { organizationId } })) return;
  await db.checklistTemplate.createMany({ data: DEFAULT_TEMPLATES.map((t) => ({ organizationId, ...t, isDefault: true })) });
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Starts a checklist for a member from a template. Tasks for the employee or their manager are
 * assigned to that person; HR tasks go to the HR pool (anyone with documents.hr.manage).
 */
export async function startChecklist(tx, ctx, { userId, kind, templateId, now, cipher, env }) {
  await ensureTemplates(tx, ctx.orgId);
  const template = templateId
    ? await tx.checklistTemplate.findFirst({ where: { organizationId: ctx.orgId, id: templateId, kind, archivedAt: null } })
    : await tx.checklistTemplate.findFirst({ where: { organizationId: ctx.orgId, kind, isDefault: true, archivedAt: null } });
  if (!template) {
    if (templateId) throw new ValidationError([{ path: 'body.templateId', message: 'Template not found' }]);
    return null;
  }
  const profile = await tx.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId } }, select: { managerUserId: true } });
  const today = localDate(now, ctx.organization?.timeZone ?? 'UTC');
  const checklist = await tx.checklist.create({ data: { organizationId: ctx.orgId, userId, kind, name: template.name, templateId: template.id, startedAt: now } });
  for (const [i, item] of template.items.entries()) {
    const assigneeId = item.assignee === 'EMPLOYEE' ? userId : item.assignee === 'MANAGER' ? (profile?.managerUserId ?? null) : null;
    const task = await tx.checklistTask.create({
      data: { organizationId: ctx.orgId, checklistId: checklist.id, sortOrder: i, title: item.title, assigneeRole: item.assignee, assigneeId, dueDate: dateOnly(addDays(today, item.dueOffsetDays ?? 0)) },
    });
    // The employee is told about their own onboarding tasks when they sign in; managers now.
    if (assigneeId && assigneeId !== ctx.userId && item.assignee === 'MANAGER' && cipher) {
      await notify(tx, ctx, {
        cipher,
        appOrigin: env.APP_ORIGIN,
        organizationId: ctx.orgId,
        recipientUserId: assigneeId,
        type: 'checklists.assigned',
        title: `${kind === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'} task: ${item.title}`,
        link: '/checklists',
        subjectType: 'checklist_task',
        subjectId: task.id,
        dedupeKey: `checklist-task:${task.id}`,
      });
    }
  }
  return checklist;
}

let hooksRegistered = false;

export function createHrService({ prisma, clock, cipher, env, fileService }) {
  // New employees get the default onboarding checklist; offboarding starts the offboarding one.
  // Registered once per process (services may be created many times, e.g. in tests).
  if (!hooksRegistered) {
    hooksRegistered = true;
    employeeCreatedHooks.push((tx, ctx, member) => startChecklist(tx, ctx, { userId: member.userId, kind: 'ONBOARDING', now: clock.now(), cipher, env }));
    offboardingHooks.push((tx, ctx, member) => startChecklist(tx, ctx, { userId: member.userId, kind: 'OFFBOARDING', now: clock.now(), cipher, env }));
  }

  async function employee(db, ctx, employeeId) {
    const m = await db.organizationMember.findFirst({ where: { organizationId: ctx.orgId, id: employeeId, memberType: 'EMPLOYEE' } });
    if (!m) throw new NotFoundError('Employee not found');
    return m;
  }

  /** HR (documents.hr.manage) sees everything; an employee sees their own documents shared with them. */
  async function canSeeDocuments(db, ctx, member) {
    if (hasOrgScope(ctx, 'documents.hr.manage') || hasOrgScope(ctx, 'documents.hr.read')) return 'all';
    if (member.userId === ctx.userId && hasPermission(ctx, 'documents.hr.read')) return 'own';
    return null;
  }

  const serializeDoc = (d, people) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    visibility: d.visibility,
    expiresOn: d.expiresOn ? isoDate(d.expiresOn) : null,
    file: { name: d.file.originalName, sizeBytes: d.file.sizeBytes, mimeType: d.file.mimeType },
    uploadedBy: people.get(d.uploadedById)?.name ?? null,
    createdAt: d.createdAt,
  });

  async function serializeChecklist(db, ctx, c) {
    const people = await memberSummaries(db, ctx.orgId, [c.userId, ...c.tasks.flatMap((t) => [t.assigneeId, t.doneById])]);
    const isHr = hasOrgScope(ctx, 'documents.hr.manage');
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      employee: { id: people.get(c.userId)?.employeeId ?? null, name: people.get(c.userId)?.name ?? null },
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      tasks: c.tasks
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => ({
          id: t.id,
          title: t.title,
          assigneeRole: t.assigneeRole,
          assignee: t.assigneeId ? { name: people.get(t.assigneeId)?.name ?? 'Former member' } : { name: 'HR' },
          dueDate: t.dueDate ? isoDate(t.dueDate) : null,
          doneAt: t.doneAt,
          doneBy: t.doneById ? people.get(t.doneById)?.name ?? null : null,
          canComplete: t.assigneeId === ctx.userId || isHr,
        })),
    };
  }

  return {
    // ─── documents ──────────────────────────────────────────────────────────

    async documents(ctx, employeeId) {
      const member = await employee(prisma, ctx, employeeId);
      const access = await canSeeDocuments(prisma, ctx, member);
      if (!access) throw new ForbiddenError('You cannot view this person’s documents');
      const rows = await prisma.employmentDocument.findMany({
        where: { organizationId: ctx.orgId, userId: member.userId, archivedAt: null, ...(access === 'own' ? { visibility: 'EMPLOYEE' } : {}) },
        include: { file: true },
        orderBy: { createdAt: 'desc' },
      });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.uploadedById));
      return rows.map((r) => serializeDoc(r, people));
    },

    async presignDocument(ctx, employeeId, { fileName, contentType, sizeBytes }) {
      await employee(prisma, ctx, employeeId);
      if (!DOC_MIME.has(contentType)) throw new ValidationError([{ path: 'body.contentType', message: 'Upload a PDF, Word document or image' }]);
      const { file, upload } = await fileService.presignUpload(prisma, ctx, { purpose: 'hr-document', fileName, contentType, sizeBytes });
      return { fileId: file.id, upload };
    },

    async addDocument(ctx, employeeId, { fileId, type, title, visibility, expiresOn }) {
      const member = await employee(prisma, ctx, employeeId);
      const file = await fileService.verifyUpload(prisma, ctx, fileId);
      if (file.purpose !== 'hr-document') throw new ValidationError([{ path: 'body.fileId', message: 'Upload the file as an HR document first' }]);
      const doc = await prisma.employmentDocument.create({
        data: { organizationId: ctx.orgId, userId: member.userId, type, title, fileId, visibility, expiresOn: expiresOn ? dateOnly(expiresOn) : null, uploadedById: ctx.userId, createdAt: clock.now() },
        include: { file: true },
      });
      await recordAudit(prisma, ctx, { action: 'documents.added', targetType: 'employee', targetId: employeeId, diff: { documentId: doc.id, type, visibility } });
      return serializeDoc(doc, await memberSummaries(prisma, ctx.orgId, [ctx.userId]));
    },

    async documentUrl(ctx, employeeId, documentId) {
      const member = await employee(prisma, ctx, employeeId);
      const access = await canSeeDocuments(prisma, ctx, member);
      const doc = await prisma.employmentDocument.findFirst({ where: { organizationId: ctx.orgId, id: documentId, userId: member.userId, archivedAt: null }, include: { file: true } });
      if (!access || !doc || (access === 'own' && doc.visibility !== 'EMPLOYEE')) throw new NotFoundError('Document not found');
      await recordAudit(prisma, ctx, { action: 'documents.downloaded', targetType: 'employee', targetId: employeeId, diff: { documentId } });
      return fileService.accessUrl(doc.file);
    },

    async archiveDocument(ctx, employeeId, documentId) {
      const member = await employee(prisma, ctx, employeeId);
      const { count } = await prisma.employmentDocument.updateMany({ where: { organizationId: ctx.orgId, id: documentId, userId: member.userId, archivedAt: null }, data: { archivedAt: clock.now() } });
      if (!count) throw new NotFoundError('Document not found');
      await recordAudit(prisma, ctx, { action: 'documents.archived', targetType: 'employee', targetId: employeeId, diff: { documentId } });
    },

    async expiringDocuments(ctx, { days }) {
      const today = localDate(clock.now(), ctx.organization?.timeZone ?? 'UTC');
      const rows = await prisma.employmentDocument.findMany({
        where: { organizationId: ctx.orgId, archivedAt: null, expiresOn: { lte: dateOnly(addDays(today, days)) } },
        include: { file: true },
        orderBy: { expiresOn: 'asc' },
      });
      const people = await memberSummaries(prisma, ctx.orgId, rows.flatMap((r) => [r.userId, r.uploadedById]));
      return rows.map((r) => ({ ...serializeDoc(r, people), employee: { id: people.get(r.userId)?.employeeId ?? null, name: people.get(r.userId)?.name ?? null }, expired: isoDate(r.expiresOn) < today }));
    },

    // ─── checklists ─────────────────────────────────────────────────────────

    async templates(ctx) {
      await ensureTemplates(prisma, ctx.orgId);
      const rows = await prisma.checklistTemplate.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
      return rows.map((t) => ({ id: t.id, kind: t.kind, name: t.name, items: t.items, isDefault: t.isDefault }));
    },

    async saveTemplate(ctx, templateId, body) {
      await ensureTemplates(prisma, ctx.orgId);
      const id = await withTransaction(prisma, async (tx) => {
        const kind = body.kind ?? (templateId ? (await tx.checklistTemplate.findFirst({ where: { organizationId: ctx.orgId, id: templateId } }))?.kind : null);
        if (!kind) throw new NotFoundError('Template not found');
        if (body.isDefault) await tx.checklistTemplate.updateMany({ where: { organizationId: ctx.orgId, kind }, data: { isDefault: false } });
        if (templateId) {
          const { archived, ...rest } = body;
          await tx.checklistTemplate.updateMany({ where: { organizationId: ctx.orgId, id: templateId }, data: { ...rest, ...(archived !== undefined ? { archivedAt: archived ? clock.now() : null } : {}) } });
          return templateId;
        }
        return (await tx.checklistTemplate.create({ data: { organizationId: ctx.orgId, ...body } })).id;
      });
      await recordAudit(prisma, ctx, { action: 'checklists.template_saved', targetType: 'checklist_template', targetId: id });
      return (await this.templates(ctx)).find((t) => t.id === id);
    },

    async checklists(ctx, employeeId) {
      const member = await employee(prisma, ctx, employeeId);
      if (member.userId !== ctx.userId && !(await coversMember(prisma, ctx, 'employees.read', member.userId))) throw new NotFoundError('Employee not found');
      const rows = await prisma.checklist.findMany({ where: { organizationId: ctx.orgId, userId: member.userId }, include: { tasks: true }, orderBy: { startedAt: 'desc' } });
      return Promise.all(rows.map((c) => serializeChecklist(prisma, ctx, c)));
    },

    async start(ctx, employeeId, { kind, templateId }) {
      const member = await employee(prisma, ctx, employeeId);
      return withTransaction(prisma, async (tx) => {
        const c = await startChecklist(tx, ctx, { userId: member.userId, kind, templateId, now: clock.now(), cipher, env });
        if (!c) throw new BusinessRuleError('There is no default template for this checklist');
        return serializeChecklist(tx, ctx, await tx.checklist.findFirst({ where: { organizationId: ctx.orgId, id: c.id }, include: { tasks: true } }));
      });
    },

    /** Open tasks for me: assigned to me, or the HR pool if I am HR. */
    async myTasks(ctx) {
      const isHr = hasOrgScope(ctx, 'documents.hr.manage');
      const tasks = await prisma.checklistTask.findMany({
        where: { organizationId: ctx.orgId, doneAt: null, OR: [{ assigneeId: ctx.userId }, ...(isHr ? [{ assigneeRole: 'HR', assigneeId: null }] : [])] },
        include: { checklist: true },
        orderBy: { dueDate: 'asc' },
        take: 200,
      });
      const people = await memberSummaries(prisma, ctx.orgId, tasks.map((t) => t.checklist.userId));
      return tasks.map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate ? isoDate(t.dueDate) : null, kind: t.checklist.kind, employee: { id: people.get(t.checklist.userId)?.employeeId ?? null, name: people.get(t.checklist.userId)?.name ?? null } }));
    },

    async completeTask(ctx, taskId, done) {
      return withTransaction(prisma, async (tx) => {
        const task = await tx.checklistTask.findFirst({ where: { organizationId: ctx.orgId, id: taskId }, include: { checklist: true } });
        if (!task) throw new NotFoundError('Task not found');
        if (task.assigneeId !== ctx.userId && !hasOrgScope(ctx, 'documents.hr.manage')) throw new ForbiddenError('This task is assigned to someone else');
        const now = clock.now();
        await tx.checklistTask.updateMany({ where: { organizationId: ctx.orgId, id: task.id }, data: { doneAt: done ? now : null, doneById: done ? ctx.userId : null } });
        const open = await tx.checklistTask.count({ where: { organizationId: ctx.orgId, checklistId: task.checklistId, doneAt: null } });
        await tx.checklist.updateMany({ where: { organizationId: ctx.orgId, id: task.checklistId }, data: { completedAt: open === 0 ? now : null } });
        return serializeChecklist(tx, ctx, await tx.checklist.findFirst({ where: { organizationId: ctx.orgId, id: task.checklistId }, include: { tasks: true } }));
      });
    },
  };
}
