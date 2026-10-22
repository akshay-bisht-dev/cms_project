import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { isoDate } from '../../utils/time.js';
import { decString, moneyString } from './money.js';

const day = (d) => new Date(`${d}T00:00:00Z`);
const effectiveOn = (date) => ({ effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] });

/**
 * The hourly billing rate for a member's time on a date (FR-FIN-1). Precedence:
 * project-member > project > client > member > organization. Returns null when none applies.
 */
export async function resolveBillRate(db, organizationId, { userId, projectId, clientId, date }) {
  const candidates = [
    projectId && { targetType: 'PROJECT_MEMBER', projectId, targetId: userId },
    projectId && { targetType: 'PROJECT', targetId: projectId },
    clientId && { targetType: 'CLIENT', targetId: clientId },
    { targetType: 'MEMBER', targetId: userId },
    { targetType: 'ORG', targetId: null },
  ].filter(Boolean);
  for (const c of candidates) {
    const rate = await db.billingRate.findFirst({ where: { organizationId, kind: 'BILL', ...c, ...effectiveOn(date) }, orderBy: { effectiveFrom: 'desc' } });
    if (rate) return { rate, source: c.targetType };
  }
  return null;
}

/** What an hour of a member's time costs on a date: member rate, else the organization default. */
export async function resolveCostRate(db, organizationId, { userId, date }) {
  for (const c of [{ targetType: 'MEMBER', targetId: userId }, { targetType: 'ORG', targetId: null }]) {
    const rate = await db.billingRate.findFirst({ where: { organizationId, kind: 'COST', ...c, ...effectiveOn(date) }, orderBy: { effectiveFrom: 'desc' } });
    if (rate) return rate;
  }
  return null;
}

export function createRateService({ prisma, clock }) {
  async function resolveTarget(ctx, { kind, targetType, targetId, projectId }) {
    if (kind === 'COST' && !['MEMBER', 'ORG'].includes(targetType)) throw new ValidationError([{ path: 'body.targetType', message: 'Cost rates apply to a member or the organization' }]);
    switch (targetType) {
      case 'ORG':
        return { targetId: null, projectId: null };
      case 'MEMBER':
        return { targetId: await resolveEmployeeUserId(prisma, ctx.orgId, targetId, 'body.targetId'), projectId: null };
      case 'CLIENT':
        if (!(await prisma.client.findFirst({ where: { organizationId: ctx.orgId, id: targetId } }))) throw new ValidationError([{ path: 'body.targetId', message: 'Client not found' }]);
        return { targetId, projectId: null };
      case 'PROJECT':
        if (!(await prisma.project.findFirst({ where: { organizationId: ctx.orgId, id: targetId } }))) throw new ValidationError([{ path: 'body.targetId', message: 'Project not found' }]);
        return { targetId, projectId: null };
      case 'PROJECT_MEMBER':
        if (!projectId || !(await prisma.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId } }))) throw new ValidationError([{ path: 'body.projectId', message: 'Project not found' }]);
        return { targetId: await resolveEmployeeUserId(prisma, ctx.orgId, targetId, 'body.targetId'), projectId };
      default:
        throw new ValidationError([{ path: 'body.targetType', message: 'Unknown target' }]);
    }
  }

  async function names(ctx, rows) {
    const people = await memberSummaries(prisma, ctx.orgId, rows.filter((r) => ['MEMBER', 'PROJECT_MEMBER'].includes(r.targetType)).map((r) => r.targetId));
    const projectIds = rows.flatMap((r) => [r.projectId, r.targetType === 'PROJECT' ? r.targetId : null]).filter(Boolean);
    const clientIds = rows.filter((r) => r.targetType === 'CLIENT').map((r) => r.targetId);
    const [projects, clients] = await Promise.all([
      projectIds.length ? prisma.project.findMany({ where: { organizationId: ctx.orgId, id: { in: projectIds } }, select: { id: true, code: true, name: true } }) : [],
      clientIds.length ? prisma.client.findMany({ where: { organizationId: ctx.orgId, id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    ]);
    const p = new Map(projects.map((x) => [x.id, `${x.code} · ${x.name}`]));
    const c = new Map(clients.map((x) => [x.id, x.name]));
    return (r) => {
      switch (r.targetType) {
        case 'ORG':
          return 'Organization default';
        case 'MEMBER':
          return people.get(r.targetId)?.name ?? 'Former member';
        case 'CLIENT':
          return c.get(r.targetId) ?? 'Unknown client';
        case 'PROJECT':
          return p.get(r.targetId) ?? 'Unknown project';
        default:
          return `${people.get(r.targetId)?.name ?? 'Former member'} on ${p.get(r.projectId) ?? 'unknown project'}`;
      }
    };
  }

  const serializeRate = (r, label, people) => ({
    id: r.id,
    kind: r.kind,
    targetType: r.targetType,
    targetId: ['MEMBER', 'PROJECT_MEMBER'].includes(r.targetType) ? (people?.get(r.targetId)?.employeeId ?? null) : r.targetId,
    projectId: r.projectId,
    target: label(r),
    amount: moneyString(r.amount, r.currency),
    currency: r.currency,
    effectiveFrom: isoDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? isoDate(r.effectiveTo) : null,
  });

  return {
    /** Billing rates for rate managers; cost rates only with finance.cost.read. */
    async listRates(ctx, { kind }) {
      if (kind === 'COST' && !hasPermission(ctx, 'finance.cost.read')) throw new ForbiddenError('You cannot view cost rates');
      const kinds = kind ? [kind] : hasPermission(ctx, 'finance.cost.read') ? ['BILL', 'COST'] : ['BILL'];
      const rows = await prisma.billingRate.findMany({ where: { organizationId: ctx.orgId, kind: { in: kinds } }, orderBy: [{ kind: 'asc' }, { targetType: 'asc' }, { effectiveFrom: 'desc' }] });
      const label = await names(ctx, rows);
      const people = await memberSummaries(prisma, ctx.orgId, rows.filter((r) => ['MEMBER', 'PROJECT_MEMBER'].includes(r.targetType)).map((r) => r.targetId));
      return rows.map((r) => serializeRate(r, label, people));
    },

    /** Adds a rate. Periods for the same kind and target may not overlap. */
    async createRate(ctx, body) {
      if (body.kind === 'COST' && !hasPermission(ctx, 'finance.cost.read')) throw new ForbiddenError('You cannot manage cost rates');
      if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) throw new ValidationError([{ path: 'body.effectiveTo', message: 'Must be on or after the start' }]);
      const target = await resolveTarget(ctx, body);
      const from = day(body.effectiveFrom);
      const to = body.effectiveTo ? day(body.effectiveTo) : null;
      const overlap = await prisma.billingRate.findFirst({
        where: {
          organizationId: ctx.orgId,
          kind: body.kind,
          targetType: body.targetType,
          targetId: target.targetId,
          projectId: target.projectId,
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
          ...(to ? { effectiveFrom: { lte: to } } : {}),
        },
      });
      if (overlap) {
        throw new ConflictError('Another rate for this target covers part of that period; end it first', 'OVERLAP', [{ path: 'body.effectiveFrom', message: `Overlaps the rate from ${isoDate(overlap.effectiveFrom)}` }]);
      }
      const rate = await prisma.billingRate.create({ data: { organizationId: ctx.orgId, kind: body.kind, targetType: body.targetType, ...target, amount: body.amount, currency: body.currency, effectiveFrom: from, effectiveTo: to } });
      await recordAudit(prisma, ctx, { action: 'finance.rate_created', targetType: 'billing_rate', targetId: rate.id, diff: { kind: rate.kind, targetType: rate.targetType, amount: String(rate.amount), currency: rate.currency } });
      const label = await names(ctx, [rate]);
      return serializeRate(rate, label, await memberSummaries(prisma, ctx.orgId, [rate.targetId]));
    },

    /** Ends a rate (sets its last day). Rates are never edited in place, so history stays true. */
    async endRate(ctx, rateId, { effectiveTo }) {
      const rate = await prisma.billingRate.findFirst({ where: { organizationId: ctx.orgId, id: rateId } });
      if (!rate) throw new NotFoundError('Rate not found');
      if (rate.kind === 'COST' && !hasPermission(ctx, 'finance.cost.read')) throw new ForbiddenError();
      if (effectiveTo < isoDate(rate.effectiveFrom)) throw new ValidationError([{ path: 'body.effectiveTo', message: 'Must be on or after the start' }]);
      await prisma.billingRate.updateMany({ where: { organizationId: ctx.orgId, id: rate.id }, data: { effectiveTo: day(effectiveTo) } });
      await recordAudit(prisma, ctx, { action: 'finance.rate_ended', targetType: 'billing_rate', targetId: rate.id, diff: { effectiveTo } });
    },

    async exchangeRates(ctx) {
      const rows = await prisma.exchangeRate.findMany({ where: { organizationId: ctx.orgId }, orderBy: [{ currency: 'asc' }, { effectiveFrom: 'desc' }] });
      return rows.map((r) => ({ id: r.id, currency: r.currency, rateToBase: decString(r.rateToBase, 8), effectiveFrom: isoDate(r.effectiveFrom) }));
    },

    async addExchangeRate(ctx, { currency, rateToBase, effectiveFrom }) {
      if (currency === ctx.organization?.baseCurrency) throw new ValidationError([{ path: 'body.currency', message: 'The base currency always converts at 1' }]);
      try {
        const row = await prisma.exchangeRate.create({ data: { organizationId: ctx.orgId, currency, rateToBase, effectiveFrom: day(effectiveFrom), createdById: ctx.userId, createdAt: clock.now() } });
        await recordAudit(prisma, ctx, { action: 'finance.exchange_rate_added', targetType: 'exchange_rate', targetId: row.id, diff: { currency, rateToBase, effectiveFrom } });
        return { id: row.id, currency, rateToBase: decString(row.rateToBase, 8), effectiveFrom };
      } catch (err) {
        if (err?.code === 'P2002') throw new ConflictError('A rate for this currency already starts on that day');
        throw err;
      }
    },

    async categories(ctx) {
      const rows = await prisma.expenseCategory.findMany({ where: { organizationId: ctx.orgId }, orderBy: { name: 'asc' } });
      return rows.map((c) => ({ id: c.id, name: c.name, archived: Boolean(c.archivedAt) }));
    },

    async saveCategory(ctx, categoryId, { name, archived }) {
      try {
        if (categoryId) {
          const { count } = await prisma.expenseCategory.updateMany({
            where: { organizationId: ctx.orgId, id: categoryId },
            data: { ...(name !== undefined ? { name } : {}), ...(archived !== undefined ? { archivedAt: archived ? clock.now() : null } : {}) },
          });
          if (!count) throw new NotFoundError('Category not found');
        } else {
          await prisma.expenseCategory.create({ data: { organizationId: ctx.orgId, name } });
        }
      } catch (err) {
        if (err?.code === 'P2002') throw new ConflictError('A category with this name exists');
        throw err;
      }
      return this.categories(ctx);
    },
  };
}
