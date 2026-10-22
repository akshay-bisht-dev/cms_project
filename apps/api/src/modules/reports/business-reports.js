import { ForbiddenError } from '../../utils/errors.js';
import { localDate, localDateRange } from '../../utils/time.js';
import { hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { ratio } from '../activity/kpi.js';
import { createFx } from '../finance/fx.js';
import { dec, hoursFromSeconds } from '../finance/money.js';
import { resolveCostRate } from '../finance/rates.service.js';
import { ticketScopeWhere } from '../tickets/tickets.service.js';
import { ensureStages } from '../crm/sales.service.js';

// Money columns carry the base currency in `currency` and values as decimal strings.
const col = (key, label, kind, type) => ({ key, label, kind, type });
const LABEL = (label) => col('label', label, null, 'text');
const money = (d) => (d === null ? null : dec(d).toFixed(2));
const sumMoney = (rows, key) => rows.reduce((s, r) => (r[key] === null ? s : s.plus(r[key])), dec(0)).toFixed(2);

function out(def, params, { columns, rows, totals, notes = [], currency }) {
  return {
    type: def.type,
    title: def.title,
    columns,
    rows,
    totals: totals ? Object.fromEntries(columns.filter((c) => c.type !== 'text').map((c) => [c.key, totals[c.key] ?? null])) : null,
    meta: { from: params.from, to: params.to, groupBy: params.groupBy ?? null, complete: true, notes, ...(currency ? { currency } : {}) },
  };
}

const window = (ctx, params) => localDateRange(params.from, params.to, ctx.organization?.timeZone ?? 'UTC');

export const BUSINESS_REPORTS = {
  pipeline: {
    type: 'pipeline',
    title: 'Sales pipeline',
    description: 'Open opportunities by stage, valued in the base currency, with the weighted forecast for deals expected to close in the period.',
    permission: 'reports.crm.read',
    groupBy: ['stage'],
    async run(db, ctx, params) {
      await ensureStages(db, ctx.orgId);
      const base = ctx.organization?.baseCurrency ?? 'USD';
      const fx = createFx(db, ctx.orgId, base);
      const stages = await db.pipelineStage.findMany({ where: { organizationId: ctx.orgId, isWon: false, isLost: false, archivedAt: null }, orderBy: { sortOrder: 'asc' } });
      const opps = await db.opportunity.findMany({ where: { organizationId: ctx.orgId, closedAt: null } });
      const missing = new Set();
      const rows = [];
      for (const s of stages) {
        let value = dec(0);
        let forecast = dec(0);
        let count = 0;
        for (const o of opps.filter((x) => x.stageId === s.id)) {
          const { amount, missing: m } = await fx.convert(o.value, o.currency);
          if (m) {
            missing.add(m);
            continue;
          }
          count += 1;
          value = value.plus(amount);
          const close = o.expectedCloseDate?.toISOString().slice(0, 10);
          if (close && close >= params.from && close <= params.to) forecast = forecast.plus(amount.times(o.probability).dividedBy(100));
        }
        rows.push({ label: s.name, count, value: money(value), forecast: money(forecast) });
      }
      const columns = [LABEL('Stage'), col('count', 'Open opportunities', 'measured', 'count'), col('value', `Pipeline value (${base})`, 'measured', 'money'), col('forecast', `Weighted forecast (${base})`, 'estimated', 'money')];
      const notes = ['Weighted forecast = value × probability for opportunities expected to close in the period.', ...(missing.size ? [`Not included (no exchange rate): ${[...missing].join(', ')}.`] : [])];
      return out(this, params, { columns, rows, totals: { count: rows.reduce((s, r) => s + r.count, 0), value: sumMoney(rows, 'value'), forecast: sumMoney(rows, 'forecast') }, notes, currency: base });
    },
  },

  leads: {
    type: 'leads',
    title: 'Lead conversion',
    description: 'Leads created in the period (the cohort) and how many have converted, by source.',
    permission: 'reports.crm.read',
    groupBy: ['source'],
    async run(db, ctx, params) {
      const [start, end] = window(ctx, params);
      const leads = await db.lead.findMany({ where: { organizationId: ctx.orgId, createdAt: { gte: start, lt: end } }, select: { source: true, status: true } });
      const groups = new Map();
      for (const l of leads) {
        const k = l.source ?? 'Unknown';
        const g = groups.get(k) ?? { label: k, created: 0, converted: 0, lost: 0 };
        g.created += 1;
        if (l.status === 'CONVERTED') g.converted += 1;
        if (l.status === 'LOST') g.lost += 1;
        groups.set(k, g);
      }
      const rows = [...groups.values()].map((g) => ({ ...g, conversion: ratio(g.converted, g.created) })).sort((a, b) => b.created - a.created);
      const t = rows.reduce((a, r) => ({ created: a.created + r.created, converted: a.converted + r.converted, lost: a.lost + r.lost }), { created: 0, converted: 0, lost: 0 });
      const columns = [LABEL('Source'), col('created', 'Leads created', 'measured', 'count'), col('converted', 'Converted', 'measured', 'count'), col('lost', 'Lost', 'measured', 'count'), col('conversion', 'Conversion', 'derived', 'percent')];
      return out(this, params, { columns, rows, totals: { ...t, conversion: ratio(t.converted, t.created) }, notes: ['Conversion = converted ÷ created, for leads created in the period (they may convert later).'] });
    },
  },

  tickets: {
    type: 'tickets',
    title: 'Support & SLA',
    description: 'Tickets created and resolved, SLA attainment and what is still open, by client or priority.',
    permission: 'tickets.read',
    groupBy: ['client', 'priority'],
    async run(db, ctx, params, now) {
      const [start, end] = window(ctx, params);
      const scope = await ticketScopeWhere(db, ctx, 'tickets.read');
      const [created, resolved, open] = await Promise.all([
        db.supportTicket.findMany({ where: { AND: [scope, { createdAt: { gte: start, lt: end } }] }, select: { clientId: true, priority: true } }),
        db.supportTicket.findMany({ where: { AND: [scope, { resolvedAt: { gte: start, lt: end } }] }, select: { clientId: true, priority: true, slaBreached: true, resolutionDueAt: true, resolvedAt: true } }),
        db.supportTicket.findMany({ where: { AND: [scope, { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT'] } }] }, select: { clientId: true, priority: true, resolutionDueAt: true } }),
      ]);
      const byClient = params.groupBy === 'client';
      const clients = byClient ? new Map((await db.client.findMany({ where: { organizationId: ctx.orgId }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : null;
      const keyOf = (t) => (byClient ? (t.clientId ? (clients.get(t.clientId) ?? 'Unknown client') : 'Internal') : t.priority);
      const groups = new Map();
      const g = (k) => groups.get(k) ?? groups.set(k, { label: k, created: 0, resolved: 0, withinSla: 0, open: 0, breachedOpen: 0 }).get(k);
      for (const t of created) g(keyOf(t)).created += 1;
      for (const t of resolved) {
        const row = g(keyOf(t));
        row.resolved += 1;
        if (!t.slaBreached && (!t.resolutionDueAt || t.resolvedAt <= t.resolutionDueAt)) row.withinSla += 1;
      }
      for (const t of open) {
        const row = g(keyOf(t));
        row.open += 1;
        if (t.resolutionDueAt && t.resolutionDueAt < now) row.breachedOpen += 1;
      }
      const rows = [...groups.values()].map((r) => ({ ...r, attainment: ratio(r.withinSla, r.resolved) }));
      const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
      const columns = [
        LABEL(byClient ? 'Client' : 'Priority'),
        col('created', 'Created', 'measured', 'count'),
        col('resolved', 'Resolved', 'measured', 'count'),
        col('withinSla', 'Resolved within SLA', 'measured', 'count'),
        col('attainment', 'SLA attainment', 'derived', 'percent'),
        col('open', 'Open now', 'measured', 'count'),
        col('breachedOpen', 'Open and past SLA', 'measured', 'count'),
      ];
      const totals = { created: sum('created'), resolved: sum('resolved'), withinSla: sum('withinSla'), open: sum('open'), breachedOpen: sum('breachedOpen') };
      return out(this, params, { columns, rows, totals: { ...totals, attainment: ratio(totals.withinSla, totals.resolved) }, notes: ['SLA attainment = tickets resolved before their resolution deadline ÷ tickets resolved in the period.'] });
    },
  },

  revenue: {
    type: 'revenue',
    title: 'Revenue & receivables',
    description: 'Invoiced and collected amounts in the period, and what is outstanding and overdue now, in the base currency.',
    permission: 'reports.finance.read',
    groupBy: ['client', 'month'],
    async run(db, ctx, params, now) {
      if (!hasOrgScope(ctx, 'reports.finance.read')) throw new ForbiddenError('Revenue reports need organization-wide finance access');
      const base = ctx.organization?.baseCurrency ?? 'USD';
      const fx = createFx(db, ctx.orgId, base);
      const from = new Date(`${params.from}T00:00:00Z`);
      const to = new Date(`${params.to}T00:00:00Z`);
      const today = localDate(now, ctx.organization?.timeZone ?? 'UTC');
      const [issued, payments, open] = await Promise.all([
        db.invoice.findMany({ where: { organizationId: ctx.orgId, status: { not: 'DRAFT' }, issueDate: { gte: from, lte: to } }, include: { client: true } }),
        db.paymentRecord.findMany({ where: { organizationId: ctx.orgId, receivedOn: { gte: from, lte: to } }, include: { invoice: { include: { client: true } } } }),
        db.invoice.findMany({ where: { organizationId: ctx.orgId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, include: { client: true } }),
      ]);
      const missing = new Set();
      const groups = new Map();
      const keyOf = (inv, date) => (params.groupBy === 'month' ? date.toISOString().slice(0, 7) : inv.client.name);
      const g = (k) => groups.get(k) ?? groups.set(k, { label: k, invoiced: dec(0), collected: dec(0), outstanding: dec(0), overdue: dec(0) }).get(k);
      const add = async (k, field, amount, currency, date) => {
        const { amount: v, missing: m } = await fx.convert(amount, currency, date);
        if (m) missing.add(m);
        else g(k)[field] = g(k)[field].plus(v);
      };
      for (const inv of issued) if (inv.status !== 'VOID') await add(keyOf(inv, inv.issueDate), 'invoiced', inv.total, inv.currency, inv.issueDate);
      for (const p of payments) await add(keyOf(p.invoice, p.receivedOn), 'collected', p.amount, p.currency, p.receivedOn);
      if (params.groupBy !== 'month') {
        for (const inv of open) {
          const due = dec(inv.total).minus(inv.amountPaid);
          await add(inv.client.name, 'outstanding', due, inv.currency, now);
          if (inv.dueDate && inv.dueDate.toISOString().slice(0, 10) < today) await add(inv.client.name, 'overdue', due, inv.currency, now);
        }
      }
      const rows = [...groups.values()].map((r) => ({ label: r.label, invoiced: money(r.invoiced), collected: money(r.collected), outstanding: params.groupBy === 'month' ? null : money(r.outstanding), overdue: params.groupBy === 'month' ? null : money(r.overdue) })).sort((a, b) => a.label.localeCompare(b.label));
      const columns = [
        LABEL(params.groupBy === 'month' ? 'Month' : 'Client'),
        col('invoiced', `Invoiced (${base})`, 'measured', 'money'),
        col('collected', `Collected (${base})`, 'measured', 'money'),
        ...(params.groupBy === 'month' ? [] : [col('outstanding', `Outstanding now (${base})`, 'measured', 'money'), col('overdue', `Overdue now (${base})`, 'measured', 'money')]),
      ];
      const notes = ['Invoiced uses issue dates; collected uses payment dates (refunds are negative). Void invoices are excluded.', ...(missing.size ? [`Not included (no exchange rate): ${[...missing].join(', ')}.`] : [])];
      return out(this, params, { columns, rows, totals: { invoiced: sumMoney(rows, 'invoiced'), collected: sumMoney(rows, 'collected'), outstanding: sumMoney(rows, 'outstanding'), overdue: sumMoney(rows, 'overdue') }, notes, currency: base });
    },
  },

  margins: {
    type: 'margins',
    title: 'Project margins',
    description: 'Revenue invoiced against cost (time × cost rate + approved expenses) per project.',
    permission: 'reports.finance.read',
    groupBy: ['project'],
    async run(db, ctx, params) {
      if (!hasPermission(ctx, 'finance.cost.read')) throw new ForbiddenError('Margins need access to cost rates');
      const base = ctx.organization?.baseCurrency ?? 'USD';
      const fx = createFx(db, ctx.orgId, base);
      const zone = ctx.organization?.timeZone ?? 'UTC';
      const [start, end] = window(ctx, params);
      const from = new Date(`${params.from}T00:00:00Z`);
      const to = new Date(`${params.to}T00:00:00Z`);
      let projectWhere = { organizationId: ctx.orgId };
      if (!hasOrgScope(ctx, 'reports.finance.read')) projectWhere = { ...projectWhere, OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] };
      const projects = await db.project.findMany({ where: projectWhere, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
      const ids = projects.map((p) => p.id);
      const [items, entries, expenses] = await Promise.all([
        db.invoiceItem.findMany({ where: { organizationId: ctx.orgId, projectId: { in: ids }, invoice: { status: { notIn: ['DRAFT', 'VOID'] }, issueDate: { gte: from, lte: to } } }, include: { invoice: { select: { currency: true, issueDate: true } } } }),
        db.timeEntry.findMany({ where: { organizationId: ctx.orgId, projectId: { in: ids }, deletedAt: null, endedAt: { not: null }, startedAt: { gte: start, lt: end } }, select: { projectId: true, userId: true, startedAt: true, durationS: true } }),
        db.expense.findMany({ where: { organizationId: ctx.orgId, projectId: { in: ids }, status: { in: ['APPROVED', 'REIMBURSED'] }, incurredOn: { gte: from, lte: to } } }),
      ]);
      const missing = new Set();
      let unpricedHours = dec(0);
      const rows = [];
      for (const p of projects) {
        let revenue = dec(0);
        let cost = dec(0);
        for (const i of items.filter((x) => x.projectId === p.id)) {
          const { amount, missing: m } = await fx.convert(i.lineTotal, i.invoice.currency, i.invoice.issueDate);
          if (m) missing.add(m);
          else revenue = revenue.plus(amount);
        }
        for (const e of entries.filter((x) => x.projectId === p.id)) {
          const rate = await resolveCostRate(db, ctx.orgId, { userId: e.userId, date: new Date(`${localDate(e.startedAt, zone)}T00:00:00Z`) });
          if (!rate) {
            unpricedHours = unpricedHours.plus(hoursFromSeconds(e.durationS));
            continue;
          }
          const { amount, missing: m } = await fx.convert(hoursFromSeconds(e.durationS).times(rate.amount), rate.currency, e.startedAt);
          if (m) missing.add(m);
          else cost = cost.plus(amount);
        }
        for (const x of expenses.filter((y) => y.projectId === p.id)) {
          const { amount, missing: m } = await fx.convert(x.amount, x.currency, x.incurredOn);
          if (m) missing.add(m);
          else cost = cost.plus(amount);
        }
        if (revenue.isZero() && cost.isZero()) continue;
        rows.push({ label: `${p.code} · ${p.name}`, revenue: money(revenue), cost: money(cost), profit: money(revenue.minus(cost)), margin: revenue.gt(0) ? Number(revenue.minus(cost).dividedBy(revenue).toFixed(4)) : null });
      }
      const totalRevenue = dec(sumMoney(rows, 'revenue'));
      const totalCost = dec(sumMoney(rows, 'cost'));
      const columns = [LABEL('Project'), col('revenue', `Revenue (${base})`, 'measured', 'money'), col('cost', `Cost (${base})`, 'derived', 'money'), col('profit', `Profit (${base})`, 'derived', 'money'), col('margin', 'Margin', 'derived', 'percent')];
      const notes = [
        'Revenue = invoiced lines (issued, not void) dated in the period. Cost = tracked time × cost rate + approved expenses.',
        ...(unpricedHours.gt(0) ? [`${unpricedHours.toFixed(2)} hours had no cost rate and are not costed.`] : []),
        ...(missing.size ? [`Not included (no exchange rate): ${[...missing].join(', ')}.`] : []),
      ];
      return out(this, params, {
        columns,
        rows,
        totals: { revenue: money(totalRevenue), cost: money(totalCost), profit: money(totalRevenue.minus(totalCost)), margin: totalRevenue.gt(0) ? Number(totalRevenue.minus(totalCost).dividedBy(totalRevenue).toFixed(4)) : null },
        notes,
        currency: base,
      });
    },
  },
};
