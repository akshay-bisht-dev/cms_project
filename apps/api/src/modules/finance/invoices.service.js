import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { formatNumber, nextSequence } from '../../services/sequences.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries } from '../shared/members.js';
import { isoDate, localDate, localDateRange } from '../../utils/time.js';
import { dec, decString, hoursFromSeconds, lineAmounts, moneyString, paymentStatus } from './money.js';
import { resolveBillRate } from './rates.service.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

const OPEN = ['ISSUED', 'PARTIALLY_PAID'];
const addDaysIso = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Invoices the caller may read: all (org), or those of projects they manage (project scope). */
export async function readableInvoicesWhere(db, ctx) {
  if (hasOrgScope(ctx, 'finance.invoices.read')) return { organizationId: ctx.orgId };
  if (!hasPermission(ctx, 'finance.invoices.read')) return { organizationId: ctx.orgId, id: '__none__' };
  const projects = await db.project.findMany({ where: { organizationId: ctx.orgId, OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] }, select: { id: true } });
  return { organizationId: ctx.orgId, status: { not: 'DRAFT' }, projectId: { in: projects.map((p) => p.id) } };
}

export function serializeInvoice(inv, { today, portal = false } = {}) {
  const outstanding = dec(inv.total).minus(inv.amountPaid);
  const c = inv.currency;
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    overdue: OPEN.includes(inv.status) && Boolean(inv.dueDate) && isoDate(inv.dueDate) < today && outstanding.gt(0),
    client: inv.client ? { id: inv.client.id, code: inv.client.code, name: inv.client.name } : null,
    projectId: inv.projectId,
    issueDate: inv.issueDate ? isoDate(inv.issueDate) : null,
    dueDate: inv.dueDate ? isoDate(inv.dueDate) : null,
    currency: c,
    subtotal: moneyString(inv.subtotal, c),
    taxTotal: moneyString(inv.taxTotal, c),
    total: moneyString(inv.total, c),
    amountPaid: moneyString(inv.amountPaid, c),
    outstanding: moneyString(inv.status === 'VOID' ? 0 : outstanding, c),
    notes: inv.notes,
    ...(portal ? {} : { voidedAt: inv.voidedAt, voidReason: inv.voidReason, version: inv.version, createdAt: inv.createdAt }),
    ...(inv.items
      ? {
          items: [...inv.items]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((i) => ({
              id: i.id,
              kind: i.kind,
              description: i.description,
              quantity: decString(i.quantity),
              unitPrice: decString(i.unitPrice),
              taxRate: decString(i.taxRate),
              lineTotal: moneyString(i.lineTotal, c),
              taxAmount: moneyString(i.taxAmount, c),
              ...(portal ? {} : { linkedEntries: i._count?.timeEntries ?? undefined, linkedExpenses: i._count?.expenses ?? undefined }),
            })),
        }
      : {}),
    ...(inv.payments
      ? { payments: inv.payments.map((p) => ({ id: p.id, amount: moneyString(p.amount, p.currency), receivedOn: isoDate(p.receivedOn), method: p.method, reference: p.reference, ...(portal ? {} : { note: p.note }) })) }
      : {}),
  };
}

const INCLUDE = { client: true, items: { include: { _count: { select: { timeEntries: true, expenses: true } } } }, payments: { orderBy: { createdAt: 'asc' } } };

export function createInvoiceService({ prisma, clock }) {
  const today = (ctx) => localDate(clock.now(), ctx.organization?.timeZone ?? 'UTC');

  async function load(db, ctx, invoiceId) {
    const inv = await db.invoice.findFirst({ where: { AND: [await readableInvoicesWhere(db, ctx), { id: invoiceId }] }, include: INCLUDE });
    if (!inv) throw new NotFoundError('Invoice not found');
    return inv;
  }

  async function loadDraft(tx, ctx, invoiceId) {
    const inv = await tx.invoice.findFirst({ where: { organizationId: ctx.orgId, id: invoiceId } });
    if (!inv) throw new NotFoundError('Invoice not found');
    if (inv.status !== 'DRAFT') throw new ConflictError('Only draft invoices can be changed', ERROR_CODES.INVALID_STATE_TRANSITION);
    return inv;
  }

  /** Recomputes totals from the stored (already rounded) lines. */
  async function refreshTotals(tx, ctx, invoiceId) {
    const items = await tx.invoiceItem.findMany({ where: { organizationId: ctx.orgId, invoiceId } });
    const subtotal = items.reduce((s, i) => s.plus(i.lineTotal), dec(0));
    const taxTotal = items.reduce((s, i) => s.plus(i.taxAmount), dec(0));
    await tx.invoice.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: invoiceId } }, data: { subtotal, taxTotal, total: subtotal.plus(taxTotal), version: { increment: 1 } } });
  }

  async function nextSort(tx, ctx, invoiceId) {
    const last = await tx.invoiceItem.findFirst({ where: { organizationId: ctx.orgId, invoiceId }, orderBy: { sortOrder: 'desc' } });
    return (last?.sortOrder ?? -1) + 1;
  }

  async function addItem(tx, ctx, invoice, { kind, description, quantity, unitPrice, taxRate = '0', projectId = null }, sortOrder) {
    return tx.invoiceItem.create({
      data: { organizationId: ctx.orgId, invoiceId: invoice.id, kind, sortOrder, description: description.slice(0, 500), quantity, unitPrice, taxRate, projectId, ...lineAmounts({ quantity, unitPrice, taxRate }, invoice.currency) },
    });
  }

  /**
   * Approved (timesheet APPROVED), billable, finished, not-yet-invoiced time of a client's
   * projects in [from, to], priced with the rate in force on each entry's day.
   */
  async function billableTime(db, ctx, { clientId, projectId, from, to, currency }) {
    const zone = ctx.organization?.timeZone ?? 'UTC';
    const [start, end] = localDateRange(from, to, zone);
    const entries = await db.timeEntry.findMany({
      where: {
        organizationId: ctx.orgId,
        isBillable: true,
        deletedAt: null,
        endedAt: { not: null },
        startedAt: { gte: start, lt: end },
        invoiceLink: { is: null },
        timesheet: { is: { timesheet: { status: 'APPROVED' } } },
        project: { is: { clientId, ...(projectId ? { id: projectId } : {}) } },
      },
      include: { project: { select: { id: true, code: true, name: true } } },
      orderBy: { startedAt: 'asc' },
    });
    const priced = [];
    const skipped = [];
    const cache = new Map();
    for (const e of entries) {
      const date = new Date(`${localDate(e.startedAt, zone)}T00:00:00Z`);
      const key = `${e.userId}|${e.projectId}|${isoDate(date)}`;
      if (!cache.has(key)) cache.set(key, await resolveBillRate(db, ctx.orgId, { userId: e.userId, projectId: e.projectId, clientId, date }));
      const found = cache.get(key);
      if (!found) skipped.push({ entryId: e.id, reason: 'NO_RATE' });
      else if (found.rate.currency !== currency) skipped.push({ entryId: e.id, reason: 'RATE_CURRENCY', currency: found.rate.currency });
      else priced.push({ entry: e, rate: found.rate, source: found.source });
    }
    return { priced, skipped, entries };
  }

  function groupPriced(priced, groupBy) {
    const groups = new Map();
    for (const p of priced) {
      const key = groupBy === 'entry' ? p.entry.id : groupBy === 'project' ? `${p.entry.projectId}|${p.rate.id}` : `${p.entry.projectId}|${p.entry.userId}|${p.rate.id}`;
      const g = groups.get(key) ?? { project: p.entry.project, userId: p.entry.userId, rate: p.rate, entries: [], seconds: 0 };
      g.entries.push(p.entry);
      g.seconds += p.entry.durationS;
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  return {
    async list(ctx, { status, clientId, projectId, overdue }) {
      const filters = [await readableInvoicesWhere(prisma, ctx)];
      if (status) filters.push({ status: { in: status } });
      if (clientId) filters.push({ clientId });
      if (projectId) filters.push({ projectId });
      if (overdue) filters.push({ status: { in: OPEN }, dueDate: { lt: new Date(`${today(ctx)}T00:00:00Z`) } });
      const rows = await prisma.invoice.findMany({ where: { AND: filters }, include: { client: true }, orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
      return rows.map((inv) => serializeInvoice(inv, { today: today(ctx) }));
    },

    async get(ctx, invoiceId) {
      return serializeInvoice(await load(prisma, ctx, invoiceId), { today: today(ctx) });
    },

    async createDraft(ctx, { clientId, projectId, currency, dueDate, notes, items = [] }) {
      return withTransaction(prisma, async (tx) => {
        const client = await tx.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } });
        if (!client) throw new ValidationError([{ path: 'body.clientId', message: 'Client not found' }]);
        if (projectId) {
          const project = await tx.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId } });
          if (!project || project.clientId !== client.id) throw new ValidationError([{ path: 'body.projectId', message: 'The project does not belong to this client' }]);
        }
        const invoice = await tx.invoice.create({
          data: { organizationId: ctx.orgId, clientId: client.id, projectId: projectId ?? null, currency: currency ?? client.defaultCurrency, dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null, notes: notes ?? null, createdById: ctx.userId },
        });
        for (const [i, item] of items.entries()) await addItem(tx, ctx, invoice, { ...item, kind: 'MANUAL' }, i);
        await refreshTotals(tx, ctx, invoice.id);
        await recordAudit(tx, ctx, { action: 'invoices.created', targetType: 'invoice', targetId: invoice.id, diff: { clientId, currency: invoice.currency } });
        return serializeInvoice(await load(tx, ctx, invoice.id), { today: today(ctx) });
      });
    },

    async updateDraft(ctx, invoiceId, { notes, dueDate, version }) {
      return withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        if (version !== undefined && version !== inv.version) throw new ConflictError('This invoice changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        await tx.invoice.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: inv.id } },
          data: { ...(notes !== undefined ? { notes } : {}), ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null } : {}), version: { increment: 1 } },
        });
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    async addManualItem(ctx, invoiceId, item) {
      return withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        await addItem(tx, ctx, inv, { ...item, kind: 'MANUAL' }, await nextSort(tx, ctx, inv.id));
        await refreshTotals(tx, ctx, inv.id);
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    /** Removing a line frees any time entries or expenses it billed. */
    async removeItem(ctx, invoiceId, itemId) {
      return withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        const { count } = await tx.invoiceItem.deleteMany({ where: { organizationId: ctx.orgId, invoiceId: inv.id, id: itemId } });
        if (!count) throw new NotFoundError('Line not found');
        await refreshTotals(tx, ctx, inv.id);
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    async deleteDraft(ctx, invoiceId) {
      await withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        await tx.invoice.deleteMany({ where: { organizationId: ctx.orgId, id: inv.id } });
        await recordAudit(tx, ctx, { action: 'invoices.draft_deleted', targetType: 'invoice', targetId: inv.id });
      });
    },

    /** Preview of what `addTime` would bill, without changing anything. */
    async previewTime(ctx, { clientId, projectId, from, to, currency, groupBy = 'member' }) {
      const client = await prisma.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } });
      if (!client) throw new ValidationError([{ path: 'query.clientId', message: 'Client not found' }]);
      const cur = currency ?? client.defaultCurrency;
      const { priced, skipped } = await billableTime(prisma, ctx, { clientId, projectId, from, to, currency: cur });
      const groups = groupPriced(priced, groupBy);
      const people = await memberSummaries(prisma, ctx.orgId, groups.map((g) => g.userId));
      return {
        currency: cur,
        lines: groups.map((g) => {
          const quantity = hoursFromSeconds(g.seconds);
          return { project: g.project, employee: groupBy === 'project' ? null : { name: people.get(g.userId)?.name ?? 'Former member' }, entries: g.entries.length, hours: decString(quantity), rate: moneyString(g.rate.amount, cur), lineTotal: moneyString(lineAmounts({ quantity, unitPrice: g.rate.amount }, cur).lineTotal, cur) };
        }),
        skipped: { noRate: skipped.filter((s) => s.reason === 'NO_RATE').length, otherCurrency: skipped.filter((s) => s.reason === 'RATE_CURRENCY').length },
      };
    },

    /**
     * Adds approved billable time as lines. Each entry is linked to its line; the unique link
     * (one invoice per time entry) makes double-billing impossible, even under concurrency.
     */
    async addTime(ctx, invoiceId, { from, to, projectId, groupBy = 'member', taxRate = '0' }) {
      return withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        const { priced } = await billableTime(tx, ctx, { clientId: inv.clientId, projectId: projectId ?? inv.projectId ?? undefined, from, to, currency: inv.currency });
        if (!priced.length) throw new BusinessRuleError('No approved, billable, priced time in that period is waiting to be invoiced');
        const groups = groupPriced(priced, groupBy);
        const people = await memberSummaries(tx, ctx.orgId, groups.map((g) => g.userId));
        let sort = await nextSort(tx, ctx, inv.id);
        for (const g of groups) {
          const quantity = hoursFromSeconds(g.seconds);
          const who = groupBy === 'project' ? '' : ` · ${people.get(g.userId)?.name ?? 'Former member'}`;
          const item = await addItem(tx, ctx, inv, { kind: 'TIME', description: `${g.project.code} ${g.project.name}${who} · ${from} to ${to}`, quantity, unitPrice: g.rate.amount, taxRate, projectId: g.project.id }, sort++);
          try {
            await tx.invoiceItemTimeEntry.createMany({ data: g.entries.map((e) => ({ organizationId: ctx.orgId, invoiceItemId: item.id, timeEntryId: e.id })) });
          } catch (err) {
            if (err?.code === 'P2002') throw new ConflictError('Some of this time was just billed on another invoice; try again', 'ALREADY_BILLED');
            throw err;
          }
        }
        await refreshTotals(tx, ctx, inv.id);
        await recordAudit(tx, ctx, { action: 'invoices.time_added', targetType: 'invoice', targetId: inv.id, diff: { entries: priced.length, from, to } });
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    async billableExpenses(ctx, invoiceId) {
      const inv = await load(prisma, ctx, invoiceId);
      const rows = await prisma.expense.findMany({
        where: { organizationId: ctx.orgId, clientId: inv.clientId, isBillable: true, status: { in: ['APPROVED', 'REIMBURSED'] }, invoiced: { is: null }, ...(inv.projectId ? { projectId: inv.projectId } : {}) },
        orderBy: { incurredOn: 'asc' },
      });
      return rows.map((e) => ({ id: e.id, description: e.description, amount: moneyString(e.amount, e.currency), currency: e.currency, incurredOn: isoDate(e.incurredOn), sameCurrency: e.currency === inv.currency }));
    },

    async addExpenses(ctx, invoiceId, { expenseIds, taxRate = '0' }) {
      return withTransaction(prisma, async (tx) => {
        const inv = await loadDraft(tx, ctx, invoiceId);
        const rows = await tx.expense.findMany({ where: { organizationId: ctx.orgId, id: { in: expenseIds }, clientId: inv.clientId, isBillable: true, status: { in: ['APPROVED', 'REIMBURSED'] } } });
        if (rows.length !== new Set(expenseIds).size) throw new ValidationError([{ path: 'body.expenseIds', message: 'Only approved billable expenses of this client can be added' }]);
        const wrong = rows.find((e) => e.currency !== inv.currency);
        if (wrong) throw new ValidationError([{ path: 'body.expenseIds', message: `"${wrong.description}" is in ${wrong.currency}; this invoice is in ${inv.currency}` }]);
        let sort = await nextSort(tx, ctx, inv.id);
        for (const e of rows) {
          const item = await addItem(tx, ctx, inv, { kind: 'EXPENSE', description: `Expense: ${e.description} (${isoDate(e.incurredOn)})`, quantity: '1', unitPrice: e.amount, taxRate, projectId: e.projectId }, sort++);
          try {
            await tx.invoiceItemExpense.create({ data: { organizationId: ctx.orgId, invoiceItemId: item.id, expenseId: e.id } });
          } catch (err) {
            if (err?.code === 'P2002') throw new ConflictError(`"${e.description}" is already on another invoice`, 'ALREADY_BILLED');
            throw err;
          }
        }
        await refreshTotals(tx, ctx, inv.id);
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    /** DRAFT → ISSUED: takes the next invoice number; the due date defaults to the client's terms. */
    async issue(ctx, invoiceId, { issueDate, dueDate }) {
      return withTransaction(prisma, async (tx) => {
        const inv = await tx.invoice.findFirst({ where: { organizationId: ctx.orgId, id: invoiceId }, include: { client: true, items: true } });
        if (!inv) throw new NotFoundError('Invoice not found');
        if (inv.status !== 'DRAFT') return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
        if (!inv.items.length || dec(inv.total).lte(0)) throw new BusinessRuleError('An invoice needs at least one line and a total above zero');
        const issued = issueDate ?? today(ctx);
        const due = dueDate ?? (inv.dueDate ? isoDate(inv.dueDate) : addDaysIso(issued, inv.client.paymentTermsDays));
        if (due < issued) throw new ValidationError([{ path: 'body.dueDate', message: 'The due date cannot be before the issue date' }]);
        const number = formatNumber('INV', await nextSequence(tx, ctx.orgId, 'INVOICE'));
        await tx.invoice.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: inv.id } },
          data: { status: 'ISSUED', number, issueDate: new Date(`${issued}T00:00:00Z`), dueDate: new Date(`${due}T00:00:00Z`), issuedById: ctx.userId, version: { increment: 1 } },
        });
        await recordAudit(tx, ctx, { action: 'invoices.issued', targetType: 'invoice', targetId: inv.id, diff: { number, total: String(inv.total), currency: inv.currency } });
        await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'invoice.issued', data: { invoiceId: inv.id, number, clientId: inv.clientId, total: inv.total.toFixed(2), currency: inv.currency } });
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    /** Voids an issued invoice with no net payments; its time and expenses become billable again. */
    async void(ctx, invoiceId, { reason }) {
      return withTransaction(prisma, async (tx) => {
        const inv = await tx.invoice.findFirst({ where: { organizationId: ctx.orgId, id: invoiceId } });
        if (!inv) throw new NotFoundError('Invoice not found');
        if (!OPEN.includes(inv.status)) throw new ConflictError(inv.status === 'DRAFT' ? 'Delete a draft instead of voiding it' : `A ${inv.status.toLowerCase().replace('_', ' ')} invoice cannot be voided`, ERROR_CODES.INVALID_STATE_TRANSITION);
        if (dec(inv.amountPaid).gt(0)) throw new BusinessRuleError('Refund the recorded payments before voiding');
        const items = await tx.invoiceItem.findMany({ where: { organizationId: ctx.orgId, invoiceId: inv.id }, select: { id: true } });
        await tx.invoiceItemTimeEntry.deleteMany({ where: { organizationId: ctx.orgId, invoiceItemId: { in: items.map((i) => i.id) } } });
        await tx.invoiceItemExpense.deleteMany({ where: { organizationId: ctx.orgId, invoiceItemId: { in: items.map((i) => i.id) } } });
        await tx.invoice.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: inv.id } }, data: { status: 'VOID', voidedAt: clock.now(), voidReason: reason, version: { increment: 1 } } });
        await recordAudit(tx, ctx, { action: 'invoices.voided', targetType: 'invoice', targetId: inv.id, diff: { reason } });
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    /**
     * Records a payment (or a refund, as a negative amount). The invoice row is locked, the paid
     * amount is re-summed from the ledger, and the status follows from it: the only way to PAID.
     */
    async recordPayment(ctx, invoiceId, { amount, receivedOn, method, reference, note }) {
      return withTransaction(prisma, async (tx) => {
        const [locked] = await tx.$queryRaw`SELECT id FROM invoices WHERE organization_id = ${ctx.orgId} AND id = ${invoiceId} FOR UPDATE`;
        if (!locked) throw new NotFoundError('Invoice not found');
        const inv = await tx.invoice.findFirst({ where: { organizationId: ctx.orgId, id: invoiceId } });
        if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.status)) throw new ConflictError(`Payments cannot be recorded on a ${inv.status.toLowerCase()} invoice`, ERROR_CODES.INVALID_STATE_TRANSITION);
        const value = dec(amount);
        if (value.isZero()) throw new ValidationError([{ path: 'body.amount', message: 'The amount cannot be zero' }]);
        const outstanding = dec(inv.total).minus(inv.amountPaid);
        if (value.gt(outstanding)) throw new BusinessRuleError(`The payment exceeds the outstanding ${moneyString(outstanding, inv.currency)} ${inv.currency}`);
        if (value.lt(0) && value.abs().gt(inv.amountPaid)) throw new BusinessRuleError('A refund cannot exceed what was paid');
        if (receivedOn < isoDate(inv.issueDate)) throw new ValidationError([{ path: 'body.receivedOn', message: 'A payment cannot predate the invoice' }]);
        const payment = await tx.paymentRecord.create({
          data: { organizationId: ctx.orgId, invoiceId: inv.id, amount: value, currency: inv.currency, receivedOn: new Date(`${receivedOn}T00:00:00Z`), method, reference: reference ?? null, note: note ?? null, recordedById: ctx.userId, createdAt: clock.now() },
        });
        const { _sum } = await tx.paymentRecord.aggregate({ where: { organizationId: ctx.orgId, invoiceId: inv.id }, _sum: { amount: true } });
        const paid = dec(_sum.amount ?? 0);
        await tx.invoice.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: inv.id } }, data: { amountPaid: paid, status: paymentStatus(inv.total, paid), version: { increment: 1 } } });
        if (paymentStatus(inv.total, paid) === 'PAID' && inv.status !== 'PAID') await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'invoice.paid', data: { invoiceId: inv.id, number: inv.number, total: inv.total.toFixed(2), currency: inv.currency } });
        await recordAudit(tx, ctx, { action: value.lt(0) ? 'invoices.refund_recorded' : 'invoices.payment_recorded', targetType: 'invoice', targetId: inv.id, diff: { paymentId: payment.id, amount: value.toFixed(4), method } });
        return serializeInvoice(await load(tx, ctx, inv.id), { today: today(ctx) });
      });
    },

    async pdfData(ctx, invoiceId) {
      const inv = await load(prisma, ctx, invoiceId);
      return { invoice: serializeInvoice(inv, { today: today(ctx) }), organization: ctx.organization, client: inv.client };
    },
  };
}
