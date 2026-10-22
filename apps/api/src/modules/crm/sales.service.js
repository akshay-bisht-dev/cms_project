import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { formatNumber, nextSequence } from '../../services/sequences.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { dec, decString, documentTotals, lineAmounts, moneyString } from '../finance/money.js';
import { createFx } from '../finance/fx.js';
import { isoDate } from '../../utils/time.js';

export const DEFAULT_STAGES = [
  { name: 'Prospecting', defaultProbability: 10 },
  { name: 'Qualification', defaultProbability: 25 },
  { name: 'Proposal', defaultProbability: 50 },
  { name: 'Negotiation', defaultProbability: 75 },
  { name: 'Won', defaultProbability: 100, isWon: true },
  { name: 'Lost', defaultProbability: 0, isLost: true },
];

const LEAD_TRANSITIONS = {
  NEW: ['CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'UNQUALIFIED', 'LOST', 'NEW'],
  QUALIFIED: ['CONTACTED', 'UNQUALIFIED', 'LOST'],
  UNQUALIFIED: ['NEW', 'CONTACTED', 'LOST'],
  LOST: ['NEW', 'CONTACTED'],
  CONVERTED: [],
};

const dateOrNull = (d) => (d ? new Date(`${d}T00:00:00Z`) : null);

/** Creates the default pipeline the first time an organization uses opportunities. */
export async function ensureStages(db, organizationId) {
  const count = await db.pipelineStage.count({ where: { organizationId } });
  if (count) return;
  await db.pipelineStage.createMany({ data: DEFAULT_STAGES.map((s, i) => ({ organizationId, sortOrder: i, isWon: false, isLost: false, ...s })), skipDuplicates: true });
}

export function createSalesService({ prisma, clock }) {
  async function owner(db, ctx, employeeId) {
    if (employeeId === undefined) return undefined;
    return employeeId ? resolveEmployeeUserId(db, ctx.orgId, employeeId, 'body.ownerId') : null;
  }

  async function people(db, ctx, ids) {
    const map = await memberSummaries(db, ctx.orgId, ids);
    return (id) => (id && map.get(id) ? { id: map.get(id).employeeId, name: map.get(id).name } : null);
  }

  const serializeLead = (l, person) => ({
    id: l.id,
    name: l.name,
    company: l.company,
    email: l.email,
    phone: l.phone,
    source: l.source,
    owner: person(l.ownerId),
    status: l.status,
    score: l.score,
    followUpAt: l.followUpAt,
    lostReason: l.lostReason,
    notes: l.notes,
    estimatedValue: l.estimatedValue ? moneyString(l.estimatedValue, l.currency) : null,
    currency: l.currency,
    convertedClientId: l.convertedClientId,
    convertedOpportunityId: l.convertedOpportunityId,
    convertedAt: l.convertedAt,
    version: l.version,
    createdAt: l.createdAt,
  });

  const serializeOpportunity = (o, person, stage) => ({
    id: o.id,
    name: o.name,
    client: o.client ? { id: o.client.id, code: o.client.code, name: o.client.name } : null,
    leadId: o.leadId,
    stage: stage ? { id: stage.id, name: stage.name, isWon: stage.isWon, isLost: stage.isLost } : null,
    value: moneyString(o.value, o.currency),
    currency: o.currency,
    probability: o.probability,
    weightedValue: moneyString(dec(o.value).times(o.probability).dividedBy(100), o.currency),
    expectedCloseDate: o.expectedCloseDate ? isoDate(o.expectedCloseDate) : null,
    owner: person(o.ownerId),
    closedAt: o.closedAt,
    lostReason: o.lostReason,
    version: o.version,
  });

  async function loadLead(db, ctx, leadId) {
    const lead = await db.lead.findFirst({ where: { organizationId: ctx.orgId, id: leadId } });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
  }

  async function stagesById(db, ctx) {
    await ensureStages(db, ctx.orgId);
    const stages = await db.pipelineStage.findMany({ where: { organizationId: ctx.orgId }, orderBy: { sortOrder: 'asc' } });
    return { list: stages, byId: new Map(stages.map((s) => [s.id, s])) };
  }

  async function assertClient(db, ctx, clientId, path = 'body.clientId') {
    if (!clientId) return null;
    const client = await db.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } });
    if (!client) throw new ValidationError([{ path, message: 'Client not found' }]);
    return client;
  }

  // ─── quotes ───────────────────────────────────────────────────────────────

  function serializeQuote(q, { status } = {}) {
    const today = isoDate(clock.now());
    const expired = q.status === 'SENT' && q.validUntil && isoDate(q.validUntil) < today;
    return {
      id: q.id,
      number: q.number,
      version: q.version,
      status: status ?? (expired ? 'EXPIRED' : q.status),
      title: q.title,
      client: q.client ? { id: q.client.id, code: q.client.code, name: q.client.name } : null,
      opportunityId: q.opportunityId,
      validUntil: q.validUntil ? isoDate(q.validUntil) : null,
      currency: q.currency,
      subtotal: moneyString(q.subtotal, q.currency),
      taxTotal: moneyString(q.taxTotal, q.currency),
      total: moneyString(q.total, q.currency),
      notes: q.notes,
      sentAt: q.sentAt,
      decidedAt: q.decidedAt,
      items: q.items?.sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({
        id: i.id,
        description: i.description,
        quantity: decString(i.quantity),
        unitPrice: decString(i.unitPrice),
        taxRate: decString(i.taxRate),
        lineTotal: moneyString(i.lineTotal, q.currency),
        taxAmount: moneyString(i.taxAmount, q.currency),
      })),
      createdAt: q.createdAt,
    };
  }

  async function writeQuoteItems(tx, ctx, quote, items) {
    await tx.quoteItem.deleteMany({ where: { organizationId: ctx.orgId, quoteId: quote.id } });
    await tx.quoteItem.createMany({
      data: items.map((item, i) => ({ organizationId: ctx.orgId, quoteId: quote.id, sortOrder: i, description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, taxRate: item.taxRate ?? '0', ...lineAmounts(item, quote.currency) })),
    });
    const totals = documentTotals(items, quote.currency);
    return tx.quote.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: quote.id } }, data: totals, include: { items: true, client: true } });
  }

  async function loadQuote(db, ctx, quoteId) {
    const quote = await db.quote.findFirst({ where: { organizationId: ctx.orgId, id: quoteId }, include: { items: true, client: true } });
    if (!quote) throw new NotFoundError('Quote not found');
    return quote;
  }

  return {
    // ─── leads ──────────────────────────────────────────────────────────────

    async listLeads(ctx, { status, ownerId, q }) {
      const where = { organizationId: ctx.orgId };
      if (status) where.status = { in: status };
      if (ownerId) where.ownerId = await resolveEmployeeUserId(prisma, ctx.orgId, ownerId, 'query.ownerId');
      if (q) where.OR = [{ name: { contains: q } }, { company: { contains: q } }, { email: { contains: q } }];
      const rows = await prisma.lead.findMany({ where, orderBy: [{ followUpAt: 'asc' }, { createdAt: 'desc' }], take: 500 });
      const person = await people(prisma, ctx, rows.map((r) => r.ownerId));
      return rows.map((r) => serializeLead(r, person));
    },

    async createLead(ctx, { ownerId, followUpAt, ...body }) {
      if (body.estimatedValue && !body.currency) throw new ValidationError([{ path: 'body.currency', message: 'A value needs a currency' }]);
      const lead = await prisma.lead.create({
        data: { organizationId: ctx.orgId, ...body, ownerId: (await owner(prisma, ctx, ownerId)) ?? ctx.userId, followUpAt: followUpAt ? new Date(followUpAt) : null },
      });
      await recordAudit(prisma, ctx, { action: 'leads.created', targetType: 'lead', targetId: lead.id });
      return serializeLead(lead, await people(prisma, ctx, [lead.ownerId]));
    },

    async updateLead(ctx, leadId, { version, ownerId, followUpAt, ...patch }) {
      return withTransaction(prisma, async (tx) => {
        const lead = await loadLead(tx, ctx, leadId);
        if (version !== undefined && version !== lead.version) throw new ConflictError('This lead changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        if (lead.status === 'CONVERTED') throw new ConflictError('A converted lead cannot be changed', ERROR_CODES.INVALID_STATE_TRANSITION);
        if (patch.status && patch.status !== lead.status) {
          if (patch.status === 'CONVERTED') throw new ValidationError([{ path: 'body.status', message: 'Use convert to convert a lead' }]);
          if (!LEAD_TRANSITIONS[lead.status].includes(patch.status)) throw new ConflictError(`A ${lead.status.toLowerCase()} lead cannot become ${patch.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
          if (patch.status === 'LOST' && !(patch.lostReason ?? lead.lostReason)) throw new ValidationError([{ path: 'body.lostReason', message: 'Say why the lead was lost' }]);
        }
        const manager = await owner(tx, ctx, ownerId);
        const updated = await tx.lead.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: lead.id } },
          data: { ...patch, ...(manager !== undefined ? { ownerId: manager } : {}), ...(followUpAt !== undefined ? { followUpAt: followUpAt ? new Date(followUpAt) : null } : {}), version: { increment: 1 } },
        });
        await recordAudit(tx, ctx, { action: 'leads.updated', targetType: 'lead', targetId: lead.id, diff: { changed: Object.keys(patch), from: lead.status, to: updated.status } });
        return serializeLead(updated, await people(tx, ctx, [updated.ownerId]));
      });
    },

    /**
     * Converts a lead in one transaction: a client (new or existing), a primary contact, and
     * optionally an opportunity in the first open stage. A lead converts once.
     */
    async convertLead(ctx, leadId, { clientId, clientName, createOpportunity, opportunityName, value, currency }) {
      if (createOpportunity && !hasPermission(ctx, 'opportunities.manage')) throw new ForbiddenError('You cannot create opportunities');
      if (!clientId && !hasPermission(ctx, 'clients.manage')) throw new ForbiddenError('You cannot create clients');
      return withTransaction(prisma, async (tx) => {
        const lead = await loadLead(tx, ctx, leadId);
        const { count } = await tx.lead.updateMany({ where: { organizationId: ctx.orgId, id: lead.id, status: { notIn: ['CONVERTED', 'LOST'] } }, data: { status: 'CONVERTED', convertedAt: clock.now() } });
        if (!count) throw new ConflictError(`A ${lead.status.toLowerCase()} lead cannot be converted`, ERROR_CODES.INVALID_STATE_TRANSITION);

        let client = await assertClient(tx, ctx, clientId);
        if (!client) {
          const name = clientName ?? lead.company ?? lead.name;
          const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'CLI';
          let code = base;
          for (let n = 2; await tx.client.findFirst({ where: { organizationId: ctx.orgId, code } }); n += 1) code = `${base}${n}`;
          client = await tx.client.create({ data: { organizationId: ctx.orgId, code, name, email: lead.email, phone: lead.phone, status: 'ACTIVE', defaultCurrency: currency ?? lead.currency ?? ctx.organization?.baseCurrency ?? 'USD', accountManagerId: lead.ownerId } });
        }
        await tx.clientContact.create({ data: { organizationId: ctx.orgId, clientId: client.id, name: lead.name, email: lead.email, phone: lead.phone, isPrimary: !(await tx.clientContact.count({ where: { organizationId: ctx.orgId, clientId: client.id, isPrimary: true } })) } });

        let opportunity = null;
        if (createOpportunity) {
          const { list } = await stagesById(tx, ctx);
          const first = list.find((s) => !s.isWon && !s.isLost && !s.archivedAt);
          const amount = value ?? lead.estimatedValue ?? '0';
          opportunity = await tx.opportunity.create({
            data: { organizationId: ctx.orgId, clientId: client.id, leadId: lead.id, name: opportunityName ?? `${client.name} opportunity`, stageId: first.id, value: amount, currency: currency ?? lead.currency ?? client.defaultCurrency, probability: first.defaultProbability, ownerId: lead.ownerId },
          });
        }
        await tx.lead.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: lead.id } }, data: { convertedClientId: client.id, convertedOpportunityId: opportunity?.id ?? null, version: { increment: 1 } } });
        await recordAudit(tx, ctx, { action: 'leads.converted', targetType: 'lead', targetId: lead.id, diff: { clientId: client.id, opportunityId: opportunity?.id ?? null } });
        return { leadId: lead.id, client: { id: client.id, code: client.code, name: client.name }, opportunityId: opportunity?.id ?? null };
      });
    },

    // ─── pipeline ───────────────────────────────────────────────────────────

    async stages(ctx) {
      const { list } = await stagesById(prisma, ctx);
      return list.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sortOrder, defaultProbability: s.defaultProbability, isWon: s.isWon, isLost: s.isLost, archived: Boolean(s.archivedAt) }));
    },

    async saveStage(ctx, stageId, body) {
      await ensureStages(prisma, ctx.orgId);
      if (body.isWon && body.isLost) throw new ValidationError([{ path: 'body.isLost', message: 'A stage cannot be both won and lost' }]);
      try {
        if (stageId) {
          const { count } = await prisma.pipelineStage.updateMany({ where: { organizationId: ctx.orgId, id: stageId }, data: body });
          if (!count) throw new NotFoundError('Stage not found');
        } else {
          const last = await prisma.pipelineStage.findFirst({ where: { organizationId: ctx.orgId }, orderBy: { sortOrder: 'desc' } });
          await prisma.pipelineStage.create({ data: { organizationId: ctx.orgId, sortOrder: (last?.sortOrder ?? -1) + 1, ...body } });
        }
      } catch (err) {
        if (err?.code === 'P2002') throw new ConflictError('A stage with this name exists');
        throw err;
      }
      await recordAudit(prisma, ctx, { action: 'opportunities.stage_saved', targetType: 'pipeline_stage', targetId: stageId ?? null, diff: body });
      return this.stages(ctx);
    },

    async listOpportunities(ctx, { stageId, clientId, ownerId, open }) {
      const { byId } = await stagesById(prisma, ctx);
      const where = { organizationId: ctx.orgId };
      if (stageId) where.stageId = stageId;
      if (clientId) where.clientId = clientId;
      if (ownerId) where.ownerId = await resolveEmployeeUserId(prisma, ctx.orgId, ownerId, 'query.ownerId');
      if (open) where.closedAt = null;
      const rows = await prisma.opportunity.findMany({ where, include: { client: true }, orderBy: [{ expectedCloseDate: 'asc' }, { createdAt: 'desc' }], take: 1000 });
      const person = await people(prisma, ctx, rows.map((r) => r.ownerId));
      return rows.map((o) => serializeOpportunity(o, person, byId.get(o.stageId)));
    },

    async saveOpportunity(ctx, opportunityId, { version, ownerId, expectedCloseDate, ...body }) {
      return withTransaction(prisma, async (tx) => {
        const { list, byId } = await stagesById(tx, ctx);
        await assertClient(tx, ctx, body.clientId);
        const existing = opportunityId ? await tx.opportunity.findFirst({ where: { organizationId: ctx.orgId, id: opportunityId } }) : null;
        if (opportunityId && !existing) throw new NotFoundError('Opportunity not found');
        if (existing && version !== undefined && version !== existing.version) throw new ConflictError('This opportunity changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        const stage = byId.get(body.stageId ?? existing?.stageId ?? list.find((s) => !s.isWon && !s.isLost)?.id);
        if (!stage || stage.archivedAt) throw new ValidationError([{ path: 'body.stageId', message: 'Stage not found' }]);
        const stageChanged = !existing || existing.stageId !== stage.id;
        if (stage.isLost && stageChanged && !(body.lostReason ?? existing?.lostReason)) throw new ValidationError([{ path: 'body.lostReason', message: 'Say why the opportunity was lost' }]);
        const data = {
          ...body,
          stageId: stage.id,
          // Moving stages takes the stage's probability unless one is given explicitly.
          probability: body.probability ?? (stageChanged ? stage.defaultProbability : existing.probability),
          closedAt: stage.isWon || stage.isLost ? (existing?.closedAt && !stageChanged ? existing.closedAt : clock.now()) : null,
          ...(expectedCloseDate !== undefined ? { expectedCloseDate: dateOrNull(expectedCloseDate) } : {}),
        };
        const manager = await owner(tx, ctx, ownerId);
        if (manager !== undefined) data.ownerId = manager;
        const saved = existing
          ? await tx.opportunity.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: existing.id } }, data: { ...data, version: { increment: 1 } }, include: { client: true } })
          : await tx.opportunity.create({ data: { organizationId: ctx.orgId, ownerId: ctx.userId, ...data }, include: { client: true } });
        await recordAudit(tx, ctx, { action: existing ? 'opportunities.updated' : 'opportunities.created', targetType: 'opportunity', targetId: saved.id, diff: { stage: stage.name, value: String(saved.value) } });
        return serializeOpportunity(saved, await people(tx, ctx, [saved.ownerId]), stage);
      });
    },

    /**
     * Pipeline value (open opportunities) and weighted forecast (value × probability, closing in
     * the period), converted to the base currency. Opportunities in currencies without a rate are
     * listed separately rather than guessed.
     */
    async pipeline(ctx, { from, to }) {
      const { list } = await stagesById(prisma, ctx);
      const base = ctx.organization?.baseCurrency ?? 'USD';
      const fx = createFx(prisma, ctx.orgId, base);
      const rows = await prisma.opportunity.findMany({ where: { organizationId: ctx.orgId, closedAt: null } });
      const unconverted = new Set();
      const byStage = new Map(list.map((s) => [s.id, { stage: { id: s.id, name: s.name }, count: 0, value: dec(0), weighted: dec(0) }]));
      let pipelineValue = dec(0);
      let forecast = dec(0);
      for (const o of rows) {
        const { amount, missing } = await fx.convert(o.value, o.currency, clock.now());
        if (missing) {
          unconverted.add(missing);
          continue;
        }
        const weighted = amount.times(o.probability).dividedBy(100);
        const entry = byStage.get(o.stageId);
        entry.count += 1;
        entry.value = entry.value.plus(amount);
        entry.weighted = entry.weighted.plus(weighted);
        pipelineValue = pipelineValue.plus(amount);
        const close = o.expectedCloseDate ? isoDate(o.expectedCloseDate) : null;
        if (close && (!from || close >= from) && (!to || close <= to)) forecast = forecast.plus(weighted);
      }
      return {
        currency: base,
        pipelineValue: { value: moneyString(pipelineValue, base), kind: 'measured' },
        weightedForecast: { value: moneyString(forecast, base), kind: 'estimated', period: { from: from ?? null, to: to ?? null } },
        stages: [...byStage.values()].filter((s) => !list.find((x) => x.id === s.stage.id).isWon && !list.find((x) => x.id === s.stage.id).isLost).map((s) => ({ ...s, value: moneyString(s.value, base), weighted: moneyString(s.weighted, base) })),
        unconvertedCurrencies: [...unconverted],
      };
    },

    // ─── sales activities ───────────────────────────────────────────────────

    async activities(ctx, { subjectType, subjectId, mine }) {
      const where = { organizationId: ctx.orgId };
      if (subjectType) Object.assign(where, { subjectType, subjectId });
      if (mine) Object.assign(where, { ownerId: ctx.userId, doneAt: null });
      const rows = await prisma.salesActivity.findMany({ where, orderBy: [{ doneAt: 'asc' }, { dueAt: 'asc' }], take: 300 });
      const person = await people(prisma, ctx, rows.map((r) => r.ownerId));
      return rows.map((a) => ({ id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, kind: a.kind, title: a.title, dueAt: a.dueAt, doneAt: a.doneAt, owner: person(a.ownerId) }));
    },

    async addActivity(ctx, { subjectType, subjectId, kind, title, dueAt, ownerId }) {
      const model = { LEAD: 'lead', OPPORTUNITY: 'opportunity', CLIENT: 'client' }[subjectType];
      if (!(await prisma[model].findFirst({ where: { organizationId: ctx.orgId, id: subjectId } }))) throw new ValidationError([{ path: 'body.subjectId', message: 'Not found' }]);
      const activity = await prisma.salesActivity.create({
        data: { organizationId: ctx.orgId, subjectType, subjectId, kind, title, dueAt: dueAt ? new Date(dueAt) : null, ownerId: (await owner(prisma, ctx, ownerId)) ?? ctx.userId },
      });
      return { id: activity.id };
    },

    async completeActivity(ctx, activityId, done) {
      const { count } = await prisma.salesActivity.updateMany({ where: { organizationId: ctx.orgId, id: activityId }, data: { doneAt: done ? clock.now() : null } });
      if (!count) throw new NotFoundError('Activity not found');
    },

    // ─── quotes ─────────────────────────────────────────────────────────────

    async listQuotes(ctx, { clientId, status }) {
      const rows = await prisma.quote.findMany({
        where: { organizationId: ctx.orgId, ...(clientId ? { clientId } : {}), ...(status ? { status } : { status: { not: 'SUPERSEDED' } }) },
        include: { client: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return rows.map((q) => serializeQuote(q));
    },

    async getQuote(ctx, quoteId) {
      return serializeQuote(await loadQuote(prisma, ctx, quoteId));
    },

    async createQuote(ctx, { clientId, opportunityId, title, currency, validUntil, notes, items }) {
      return withTransaction(prisma, async (tx) => {
        const client = await assertClient(tx, ctx, clientId);
        if (opportunityId && !(await tx.opportunity.findFirst({ where: { organizationId: ctx.orgId, id: opportunityId, clientId } }))) {
          throw new ValidationError([{ path: 'body.opportunityId', message: 'Opportunity not found for this client' }]);
        }
        const number = formatNumber('QUO', await nextSequence(tx, ctx.orgId, 'QUOTE'));
        const quote = await tx.quote.create({
          data: { organizationId: ctx.orgId, clientId: client.id, opportunityId: opportunityId ?? null, number, title, currency: currency ?? client.defaultCurrency, validUntil: dateOrNull(validUntil), notes: notes ?? null, createdById: ctx.userId },
        });
        const saved = await writeQuoteItems(tx, ctx, quote, items);
        await recordAudit(tx, ctx, { action: 'quotes.created', targetType: 'quote', targetId: quote.id, diff: { number, total: String(saved.total) } });
        return serializeQuote(saved);
      });
    },

    async updateQuote(ctx, quoteId, { title, validUntil, notes, items }) {
      return withTransaction(prisma, async (tx) => {
        const quote = await loadQuote(tx, ctx, quoteId);
        if (quote.status !== 'DRAFT') throw new ConflictError('Only draft quotes can be edited; create a revision instead', ERROR_CODES.INVALID_STATE_TRANSITION);
        const updated = await tx.quote.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: quote.id } },
          data: { ...(title !== undefined ? { title } : {}), ...(notes !== undefined ? { notes } : {}), ...(validUntil !== undefined ? { validUntil: dateOrNull(validUntil) } : {}) },
        });
        return serializeQuote(items ? await writeQuoteItems(tx, ctx, updated, items) : await loadQuote(tx, ctx, quote.id));
      });
    },

    /** DRAFT → SENT, SENT → ACCEPTED/DECLINED. Accepting moves a linked opportunity to Won. */
    async transitionQuote(ctx, quoteId, action) {
      return withTransaction(prisma, async (tx) => {
        const quote = await loadQuote(tx, ctx, quoteId);
        const effective = serializeQuote(quote).status;
        const rules = { send: ['DRAFT', 'SENT'], accept: ['SENT', 'ACCEPTED'], decline: ['SENT', 'DECLINED'] }[action];
        if (effective !== rules[0]) throw new ConflictError(`A ${effective.toLowerCase()} quote cannot be ${action === 'send' ? 'sent' : `${action}ed`}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        if (action === 'send' && !quote.items.length) throw new BusinessRuleError('Add at least one line before sending');
        const now = clock.now();
        await tx.quote.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: quote.id } }, data: { status: rules[1], ...(action === 'send' ? { sentAt: now } : { decidedAt: now }) } });
        if (action === 'accept' && quote.opportunityId) {
          const won = await tx.pipelineStage.findFirst({ where: { organizationId: ctx.orgId, isWon: true, archivedAt: null } });
          if (won) await tx.opportunity.updateMany({ where: { organizationId: ctx.orgId, id: quote.opportunityId, closedAt: null }, data: { stageId: won.id, probability: 100, closedAt: now, version: { increment: 1 } } });
        }
        await recordAudit(tx, ctx, { action: `quotes.${action === 'send' ? 'sent' : `${action}ed`}`, targetType: 'quote', targetId: quote.id });
        return serializeQuote(await loadQuote(tx, ctx, quote.id));
      });
    },

    /** A sent or declined quote is revised as a new version (same number); the old one is kept. */
    async reviseQuote(ctx, quoteId) {
      return withTransaction(prisma, async (tx) => {
        const quote = await loadQuote(tx, ctx, quoteId);
        if (!['SENT', 'DECLINED'].includes(quote.status)) throw new ConflictError('Only sent or declined quotes can be revised', ERROR_CODES.INVALID_STATE_TRANSITION);
        const latest = await tx.quote.findFirst({ where: { organizationId: ctx.orgId, number: quote.number }, orderBy: { version: 'desc' } });
        if (latest.id !== quote.id) throw new ConflictError('A newer version of this quote exists');
        await tx.quote.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: quote.id } }, data: { status: 'SUPERSEDED' } });
        const next = await tx.quote.create({
          data: { organizationId: ctx.orgId, clientId: quote.clientId, opportunityId: quote.opportunityId, number: quote.number, version: quote.version + 1, title: quote.title, currency: quote.currency, validUntil: quote.validUntil, notes: quote.notes, createdById: ctx.userId },
        });
        const saved = await writeQuoteItems(tx, ctx, next, quote.items.sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxRate: i.taxRate })));
        await recordAudit(tx, ctx, { action: 'quotes.revised', targetType: 'quote', targetId: next.id, diff: { from: quote.id, version: next.version } });
        return serializeQuote(saved);
      });
    },
  };
}
