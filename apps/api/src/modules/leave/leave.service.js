import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { dateOnly, isoDate, localDate, scheduleWindow } from '../../utils/time.js';
import { coversMember, hasOrgScope, hasPermission, resolveMemberScope } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { memberCalendar } from '../attendance/schedule.js';
import { notify } from '../notifications/notifications.service.js';
import { markStatsDirty } from '../activity/activity.js';
import { countLeaveDays, datesBetween, halfDaySlots, slotsOverlap, validateHalves } from './leave-days.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

const D = Prisma.Decimal;
export const APPROVAL_RULES = ['MANAGER', 'TEAM_LEAD', 'HR'];
export const DEFAULT_LEAVE_TYPES = [
  { code: 'ANNUAL', name: 'Annual leave', color: '#2563eb', policy: { accrual: 'ANNUAL', accrualDays: '20', carryOverMaxDays: '5', approvalChain: ['MANAGER', 'HR'] } },
  { code: 'SICK', name: 'Sick leave', color: '#0e7490', policy: { accrual: 'ANNUAL', accrualDays: '10', approvalChain: ['MANAGER'] } },
  { code: 'UNPAID', name: 'Unpaid leave', isPaid: false, color: '#6b7280', policy: { accrual: 'NONE', accrualDays: '0', allowNegative: true, approvalChain: ['MANAGER', 'HR'] } },
];
const ACTIVE = ['PENDING', 'APPROVED'];
const yearRange = (year) => ({ gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) });
const days = (v) => Number(new D(v).toFixed(2));

/** Creates the default leave types and policies the first time an organization uses leave. */
export async function ensureLeaveSetup(db, organizationId) {
  if (await db.leaveType.count({ where: { organizationId } })) return;
  for (const t of DEFAULT_LEAVE_TYPES) {
    const type = await db.leaveType.create({ data: { organizationId, code: t.code, name: t.name, isPaid: t.isPaid ?? true, color: t.color } }).catch((err) => {
      if (err?.code === 'P2002') return null; // created concurrently
      throw err;
    });
    if (type) await db.leavePolicy.create({ data: { organizationId, leaveTypeId: type.id, name: `${t.name} (default)`, isDefault: true, ...t.policy } });
  }
}

/** Policy for a member and leave type: member > team > department > the type's default. */
export async function resolveLeavePolicy(db, organizationId, userId, leaveTypeId) {
  const [profile, teams] = await Promise.all([
    db.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { departmentId: true } }),
    db.teamMember.findMany({ where: { organizationId, userId }, select: { teamId: true } }),
  ]);
  const assignments = await db.leavePolicyAssignment.findMany({
    where: {
      organizationId,
      policy: { leaveTypeId, archivedAt: null },
      OR: [
        { targetType: 'MEMBER', targetId: userId },
        ...(teams.length ? [{ targetType: 'TEAM', targetId: { in: teams.map((t) => t.teamId) } }] : []),
        ...(profile?.departmentId ? [{ targetType: 'DEPARTMENT', targetId: profile.departmentId }] : []),
      ],
    },
    include: { policy: true },
    orderBy: { createdAt: 'desc' },
  });
  for (const level of ['MEMBER', 'TEAM', 'DEPARTMENT']) {
    const match = assignments.find((a) => a.targetType === level);
    if (match) return match.policy;
  }
  return db.leavePolicy.findFirst({ where: { organizationId, leaveTypeId, isDefault: true, archivedAt: null } });
}

/** Ledger balance for a leave year (calendar year of the effective dates). */
export async function ledgerBalance(db, organizationId, userId, leaveTypeId, year) {
  const { _sum } = await db.leaveLedgerEntry.aggregate({ where: { organizationId, userId, leaveTypeId, effectiveDate: yearRange(year) }, _sum: { days: true } });
  return new D(_sum.days ?? 0);
}

async function pendingDays(db, organizationId, userId, leaveTypeId, year, excludeId) {
  const { _sum } = await db.leaveRequest.aggregate({
    where: { organizationId, userId, leaveTypeId, status: 'PENDING', startDate: yearRange(year), ...(excludeId ? { id: { not: excludeId } } : {}) },
    _sum: { days: true },
  });
  return new D(_sum.days ?? 0);
}

/** Members holding leave.approve at organization scope (HR approvers). */
async function orgApprovers(db, organizationId) {
  const grants = await db.rolePermission.findMany({ where: { organizationId, permissionKey: 'leave.approve', scope: 'ORG' }, select: { roleId: true } });
  if (!grants.length) return [];
  const members = await db.memberRole.findMany({ where: { organizationId, roleId: { in: grants.map((g) => g.roleId) }, member: { status: 'ACTIVE', memberType: 'EMPLOYEE' } }, select: { userId: true } });
  return [...new Set(members.map((m) => m.userId))];
}

/**
 * Resolves the policy's approval rules into concrete approvers for this person. Steps nobody can
 * take (e.g. no manager) are skipped; if none remain, HR approves. The requester never approves.
 */
export async function resolveChain(db, organizationId, userId, rules) {
  const steps = [];
  for (const rule of rules) {
    let ids = [];
    if (rule === 'MANAGER') {
      const profile = await db.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { managerUserId: true } });
      if (profile?.managerUserId) {
        const m = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: profile.managerUserId } } });
        if (m?.status === 'ACTIVE') ids = [m.userId];
      }
    } else if (rule === 'TEAM_LEAD') {
      const teams = await db.team.findMany({ where: { organizationId, archivedAt: null, leadUserId: { not: null }, members: { some: { userId } } }, select: { leadUserId: true } });
      ids = teams.map((t) => t.leadUserId);
    } else if (rule === 'HR') {
      ids = await orgApprovers(db, organizationId);
    }
    ids = [...new Set(ids)].filter((id) => id !== userId);
    if (ids.length) steps.push({ rule, approverIds: ids });
  }
  if (!steps.length) {
    const hr = (await orgApprovers(db, organizationId)).filter((id) => id !== userId);
    steps.push({ rule: 'HR', approverIds: hr });
  }
  return steps;
}

/**
 * 1 for a scheduled working day, 0.5 on a half-day holiday, 0 otherwise. Without any schedule
 * (none assigned and no organization default) the working week is Monday–Friday, so leave can
 * still be taken before schedules are set up.
 */
async function workWeights(db, organizationId, userId, from, to) {
  const { zone, schedule } = await memberCalendar(db, organizationId, userId);
  const holidays = new Map((await db.holiday.findMany({ where: { organizationId, date: { gte: dateOnly(from), lte: dateOnly(to) } } })).map((h) => [isoDate(h.date), h]));
  return (date) => {
    if (schedule ? !scheduleWindow(schedule, date, zone) : DateTime.fromISO(date, { zone }).weekday > 5) return 0;
    const h = holidays.get(date);
    if (!h) return 1;
    return h.isHalfDay ? 0.5 : 0;
  };
}

export function createLeaveService({ prisma, clock, cipher, env }) {
  const notifyOpts = { cipher, appOrigin: env.APP_ORIGIN };
  const today = (ctx) => localDate(clock.now(), ctx.organization?.timeZone ?? 'UTC');

  async function loadType(db, ctx, leaveTypeId) {
    const type = await db.leaveType.findFirst({ where: { organizationId: ctx.orgId, id: leaveTypeId, archivedAt: null } });
    if (!type) throw new ValidationError([{ path: 'body.leaveTypeId', message: 'Leave type not found' }]);
    return type;
  }

  async function quote(db, ctx, userId, body) {
    const type = await loadType(db, ctx, body.leaveTypeId);
    const request = { startDate: body.startDate, endDate: body.endDate, startHalf: body.startHalf ?? 'FULL', endHalf: body.endHalf ?? 'FULL' };
    const problem = validateHalves(request, type);
    if (problem) throw new ValidationError([{ path: 'body.endDate', message: problem }]);
    const weight = await workWeights(db, ctx.orgId, userId, request.startDate, request.endDate);
    const count = countLeaveDays(request, weight);
    const policy = await resolveLeavePolicy(db, ctx.orgId, userId, type.id);
    const year = Number(request.startDate.slice(0, 4));
    const balance = await ledgerBalance(db, ctx.orgId, userId, type.id, year);
    const pending = await pendingDays(db, ctx.orgId, userId, type.id, year, body.excludeId);
    return { type, request, days: count, policy, year, balance, pending, available: balance.minus(pending) };
  }

  async function serialize(db, ctx, rows) {
    const people = await memberSummaries(db, ctx.orgId, rows.flatMap((r) => [r.userId, ...(r.approvals ?? []).map((a) => a.actorId), ...(r.chain ?? []).flatMap((s) => s.approverIds)]));
    const types = new Map((await db.leaveType.findMany({ where: { organizationId: ctx.orgId } })).map((t) => [t.id, t]));
    const person = (id) => (people.get(id) ? { id: people.get(id).employeeId, name: people.get(id).name } : { id: null, name: 'Former member' });
    return rows.map((r) => {
      const step = r.status === 'PENDING' ? r.chain[r.currentStep] : null;
      return {
        id: r.id,
        employee: person(r.userId),
        leaveType: { id: r.leaveTypeId, code: types.get(r.leaveTypeId)?.code, name: types.get(r.leaveTypeId)?.name, color: types.get(r.leaveTypeId)?.color },
        startDate: isoDate(r.startDate),
        endDate: isoDate(r.endDate),
        startHalf: r.startHalf,
        endHalf: r.endHalf,
        days: days(r.days),
        reason: r.reason,
        status: r.status,
        step: step ? { index: r.currentStep, of: r.chain.length, rule: step.rule, approvers: step.approverIds.map(person) } : null,
        canDecide: Boolean(step && r.userId !== ctx.userId && hasPermission(ctx, 'leave.approve') && (step.approverIds.includes(ctx.userId) || hasOrgScope(ctx, 'leave.approve'))),
        history: (r.approvals ?? []).map((a) => ({ step: a.step, action: a.action, comment: a.comment, at: a.createdAt, actor: person(a.actorId) })),
        createdAt: r.createdAt,
        version: r.version,
      };
    });
  }

  async function lockMember(tx, organizationId, userId) {
    await tx.$queryRaw`SELECT user_id FROM organization_members WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR UPDATE`;
  }

  async function notifyApprovers(tx, ctx, request, step, requesterName) {
    for (const approverId of step.approverIds) {
      await notify(tx, ctx, {
        ...notifyOpts,
        organizationId: ctx.orgId,
        recipientUserId: approverId,
        type: 'leave.requested',
        title: `${requesterName} requested ${days(request.days)} day(s) of leave`,
        body: `${isoDate(request.startDate)} to ${isoDate(request.endDate)}`,
        link: '/leave?view=approvals',
        subjectType: 'leave_request',
        subjectId: request.id,
        dedupeKey: `leave-requested:${request.id}:${request.currentStep}:${approverId}`,
      });
    }
  }

  async function notifyRequester(tx, ctx, request, outcome, comment) {
    if (request.userId === ctx.userId) return;
    await notify(tx, ctx, {
      ...notifyOpts,
      organizationId: ctx.orgId,
      recipientUserId: request.userId,
      type: 'leave.decided',
      title: `Your leave from ${isoDate(request.startDate)} was ${outcome}`,
      body: comment ?? null,
      link: '/leave',
      subjectType: 'leave_request',
      subjectId: request.id,
      dedupeKey: `leave-decided:${request.id}:${outcome}`,
    });
  }

  const touchDays = (tx, ctx, request) => markStatsDirty(tx, ctx.orgId, request.userId, datesBetween(isoDate(request.startDate), isoDate(request.endDate)).map((d) => new Date(`${d}T12:00:00Z`)));

  async function loadRequest(db, ctx, requestId) {
    const r = await db.leaveRequest.findFirst({ where: { organizationId: ctx.orgId, id: requestId }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundError('Leave request not found');
    if (r.userId !== ctx.userId && !(await coversMember(db, ctx, 'leave.read', r.userId)) && !r.chain.some((s) => s.approverIds.includes(ctx.userId))) throw new NotFoundError('Leave request not found');
    return r;
  }

  return {
    // ─── types & policies ───────────────────────────────────────────────────

    async types(ctx) {
      await ensureLeaveSetup(prisma, ctx.orgId);
      const rows = await prisma.leaveType.findMany({ where: { organizationId: ctx.orgId }, orderBy: { name: 'asc' } });
      return rows.map((t) => ({ id: t.id, code: t.code, name: t.name, isPaid: t.isPaid, allowsHalfDay: t.allowsHalfDay, color: t.color, archived: Boolean(t.archivedAt) }));
    },

    async saveType(ctx, typeId, body) {
      await ensureLeaveSetup(prisma, ctx.orgId);
      try {
        if (typeId) {
          const { count } = await prisma.leaveType.updateMany({ where: { organizationId: ctx.orgId, id: typeId }, data: { ...body, ...(body.archived !== undefined ? { archivedAt: body.archived ? clock.now() : null, archived: undefined } : {}) } });
          if (!count) throw new NotFoundError('Leave type not found');
        } else {
          const type = await prisma.leaveType.create({ data: { organizationId: ctx.orgId, ...body } });
          await prisma.leavePolicy.create({ data: { organizationId: ctx.orgId, leaveTypeId: type.id, name: `${type.name} (default)`, isDefault: true, accrual: 'NONE', approvalChain: ['MANAGER', 'HR'] } });
        }
      } catch (err) {
        if (err?.code === 'P2002') throw new ConflictError('A leave type with this code exists');
        throw err;
      }
      await recordAudit(prisma, ctx, { action: 'leave.type_saved', targetType: 'leave_type', targetId: typeId ?? null, diff: body });
      return this.types(ctx);
    },

    async policies(ctx) {
      await ensureLeaveSetup(prisma, ctx.orgId);
      const rows = await prisma.leavePolicy.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, include: { leaveType: true, assignments: true }, orderBy: [{ leaveTypeId: 'asc' }, { isDefault: 'desc' }] });
      // Members are exposed by employee id (the public id), like everywhere else in the API.
      const people = await memberSummaries(prisma, ctx.orgId, rows.flatMap((p) => p.assignments.filter((a) => a.targetType === 'MEMBER').map((a) => a.targetId)));
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        leaveType: { id: p.leaveType.id, name: p.leaveType.name },
        accrual: p.accrual,
        accrualDays: days(p.accrualDays),
        capDays: p.capDays === null ? null : days(p.capDays),
        carryOverMaxDays: p.carryOverMaxDays === null ? null : days(p.carryOverMaxDays),
        allowNegative: p.allowNegative,
        approvalChain: p.approvalChain,
        isDefault: p.isDefault,
        assignments: p.assignments.map((a) => ({ targetType: a.targetType, targetId: a.targetType === 'MEMBER' ? (people.get(a.targetId)?.employeeId ?? null) : a.targetId })),
      }));
    },

    async savePolicy(ctx, policyId, body) {
      await ensureLeaveSetup(prisma, ctx.orgId);
      if (body.leaveTypeId) await loadType(prisma, ctx, body.leaveTypeId);
      const saved = await withTransaction(prisma, async (tx) => {
        if (policyId) {
          const existing = await tx.leavePolicy.findFirst({ where: { organizationId: ctx.orgId, id: policyId } });
          if (!existing) throw new NotFoundError('Policy not found');
          if (body.isDefault) await tx.leavePolicy.updateMany({ where: { organizationId: ctx.orgId, leaveTypeId: existing.leaveTypeId, id: { not: existing.id } }, data: { isDefault: false } });
          await tx.leavePolicy.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: policyId } }, data: body });
          return policyId;
        }
        if (body.isDefault) await tx.leavePolicy.updateMany({ where: { organizationId: ctx.orgId, leaveTypeId: body.leaveTypeId }, data: { isDefault: false } });
        return (await tx.leavePolicy.create({ data: { organizationId: ctx.orgId, ...body } })).id;
      });
      await recordAudit(prisma, ctx, { action: 'leave.policy_saved', targetType: 'leave_policy', targetId: saved, diff: body });
      return (await this.policies(ctx)).find((p) => p.id === saved);
    },

    async assignPolicy(ctx, policyId, targets) {
      const policy = await prisma.leavePolicy.findFirst({ where: { organizationId: ctx.orgId, id: policyId } });
      if (!policy) throw new NotFoundError('Policy not found');
      const rows = [];
      for (const [i, t] of targets.entries()) {
        if (t.type === 'MEMBER') rows.push({ targetType: 'MEMBER', targetId: await resolveEmployeeUserId(prisma, ctx.orgId, t.id, `body.targets.${i}.id`) });
        else {
          const model = t.type === 'TEAM' ? prisma.team : prisma.department;
          if (!(await model.findFirst({ where: { organizationId: ctx.orgId, id: t.id } }))) throw new ValidationError([{ path: `body.targets.${i}.id`, message: 'Not found' }]);
          rows.push({ targetType: t.type, targetId: t.id });
        }
      }
      await withTransaction(prisma, async (tx) => {
        await tx.leavePolicyAssignment.deleteMany({ where: { organizationId: ctx.orgId, policyId } });
        if (rows.length) await tx.leavePolicyAssignment.createMany({ data: rows.map((r) => ({ organizationId: ctx.orgId, policyId, ...r })) });
        await recordAudit(tx, ctx, { action: 'leave.policy_assigned', targetType: 'leave_policy', targetId: policyId, diff: { targets: rows } });
      });
      return (await this.policies(ctx)).find((p) => p.id === policyId);
    },

    // ─── balances ───────────────────────────────────────────────────────────

    async balances(ctx, { employeeId, year }) {
      await ensureLeaveSetup(prisma, ctx.orgId);
      const userId = employeeId ? await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId') : ctx.userId;
      if (userId !== ctx.userId && !(await coversMember(prisma, ctx, 'leave.read', userId))) throw new ForbiddenError('You cannot view this person’s leave');
      const y = year ?? Number(today(ctx).slice(0, 4));
      const types = await prisma.leaveType.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, orderBy: { name: 'asc' } });
      const out = [];
      for (const t of types) {
        const policy = await resolveLeavePolicy(prisma, ctx.orgId, userId, t.id);
        const balance = await ledgerBalance(prisma, ctx.orgId, userId, t.id, y);
        const pending = await pendingDays(prisma, ctx.orgId, userId, t.id, y);
        const { _sum } = await prisma.leaveLedgerEntry.aggregate({ where: { organizationId: ctx.orgId, userId, leaveTypeId: t.id, effectiveDate: yearRange(y), entryType: 'USAGE' }, _sum: { days: true } });
        out.push({
          leaveType: { id: t.id, code: t.code, name: t.name, color: t.color, isPaid: t.isPaid },
          policy: policy ? { id: policy.id, name: policy.name, accrual: policy.accrual, allowNegative: policy.allowNegative } : null,
          year: y,
          balance: days(balance),
          used: -days(_sum.days ?? 0),
          pending: days(pending),
          available: days(balance.minus(pending)),
        });
      }
      return out;
    },

    async ledger(ctx, { employeeId, leaveTypeId, year }) {
      const userId = employeeId ? await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId') : ctx.userId;
      if (userId !== ctx.userId && !(await coversMember(prisma, ctx, 'leave.read', userId))) throw new ForbiddenError();
      const y = year ?? Number(today(ctx).slice(0, 4));
      const rows = await prisma.leaveLedgerEntry.findMany({ where: { organizationId: ctx.orgId, userId, leaveTypeId, effectiveDate: yearRange(y) }, orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }] });
      let running = new D(0);
      return rows.map((r) => {
        running = running.plus(r.days);
        return { id: r.id, entryType: r.entryType, days: days(r.days), effectiveDate: isoDate(r.effectiveDate), note: r.note, running: days(running) };
      });
    },

    async adjust(ctx, { employeeId, leaveTypeId, days: delta, effectiveDate, note }) {
      const userId = await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'body.employeeId');
      if (userId === ctx.userId) throw new ForbiddenError('You cannot adjust your own leave balance');
      await loadType(prisma, ctx, leaveTypeId);
      await withTransaction(prisma, async (tx) => {
        await tx.leaveLedgerEntry.create({
          data: { organizationId: ctx.orgId, userId, leaveTypeId, entryType: 'ADJUSTMENT', days: delta, effectiveDate: dateOnly(effectiveDate ?? today(ctx)), note, idempotencyKey: `adjust:${randomUUID()}`, createdById: ctx.userId },
        });
        await recordAudit(tx, ctx, { action: 'leave.balance_adjusted', targetType: 'employee', targetId: employeeId, diff: { leaveTypeId, days: delta, note } });
      });
      return this.balances(ctx, { employeeId, year: Number((effectiveDate ?? today(ctx)).slice(0, 4)) });
    },

    // ─── requests ───────────────────────────────────────────────────────────

    async preview(ctx, body) {
      const q = await quote(prisma, ctx, ctx.userId, body);
      return { days: q.days, balance: days(q.balance), pending: days(q.pending), available: days(q.available), afterRequest: days(q.available.minus(q.days)), allowNegative: Boolean(q.policy?.allowNegative) };
    },

    /**
     * Requests leave. Under a lock on the member: no overlap with their pending or approved leave
     * (half-day precision), enough balance unless the policy allows going negative, and the
     * approval chain resolved now (so later org changes don't reroute a pending request).
     */
    async request(ctx, body) {
      return withTransaction(prisma, async (tx) => {
        await lockMember(tx, ctx.orgId, ctx.userId);
        const q = await quote(tx, ctx, ctx.userId, body);
        if (q.days <= 0) throw new BusinessRuleError('These dates contain no working days');
        if (!q.policy) throw new BusinessRuleError('No leave policy applies to you for this leave type');
        const slots = halfDaySlots(q.request);
        const existing = await tx.leaveRequest.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId, status: { in: ACTIVE }, startDate: { lte: dateOnly(q.request.endDate) }, endDate: { gte: dateOnly(q.request.startDate) } } });
        const clash = existing.find((e) => slotsOverlap(slots, halfDaySlots({ startDate: isoDate(e.startDate), endDate: isoDate(e.endDate), startHalf: e.startHalf, endHalf: e.endHalf })));
        if (clash) throw new ConflictError(`This overlaps your ${clash.status.toLowerCase()} leave from ${isoDate(clash.startDate)}`, ERROR_CODES.OVERLAP);
        if (!q.policy.allowNegative && q.available.lt(q.days)) {
          throw new BusinessRuleError(`Not enough ${q.type.name.toLowerCase()}: ${days(q.available)} day(s) available, ${q.days} requested`, 'INSUFFICIENT_BALANCE');
        }
        const chain = await resolveChain(tx, ctx.orgId, ctx.userId, q.policy.approvalChain);
        if (!chain[0].approverIds.length) throw new BusinessRuleError('Nobody can approve this request; ask HR to set up approvers');
        const created = await tx.leaveRequest.create({
          data: { organizationId: ctx.orgId, userId: ctx.userId, leaveTypeId: q.type.id, policyId: q.policy.id, ...q.request, startDate: dateOnly(q.request.startDate), endDate: dateOnly(q.request.endDate), days: q.days, reason: body.reason ?? null, chain, createdAt: clock.now() },
          include: { approvals: true },
        });
        await recordAudit(tx, ctx, { action: 'leave.requested', targetType: 'leave_request', targetId: created.id, diff: { days: q.days, type: q.type.code } });
        await notifyApprovers(tx, ctx, created, chain[0], ctx.user.name);
        return (await serialize(tx, ctx, [created]))[0];
      });
    },

    async list(ctx, { view = 'mine', status, from, to, employeeId }) {
      let where = { organizationId: ctx.orgId };
      if (view === 'mine') where.userId = ctx.userId;
      else if (view === 'approvals') where = { ...where, status: 'PENDING', userId: { not: ctx.userId } };
      else {
        const scope = await resolveMemberScope(prisma, ctx, 'leave.read');
        if (!scope.all) where.userId = { in: [...scope.userIds] };
        if (employeeId) {
          const userId = await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId');
          if (!(await coversMember(prisma, ctx, 'leave.read', userId))) throw new ForbiddenError();
          where.userId = userId;
        }
      }
      if (status) where.status = { in: status };
      if (from) where.endDate = { gte: dateOnly(from) };
      if (to) where.startDate = { lte: dateOnly(to) };
      let rows = await prisma.leaveRequest.findMany({ where, include: { approvals: { orderBy: { createdAt: 'asc' } } }, orderBy: { startDate: 'desc' }, take: 500 });
      if (view === 'approvals') rows = rows.filter((r) => r.chain[r.currentStep]?.approverIds.includes(ctx.userId) || hasOrgScope(ctx, 'leave.approve'));
      return serialize(prisma, ctx, rows);
    },

    async get(ctx, requestId) {
      return (await serialize(prisma, ctx, [await loadRequest(prisma, ctx, requestId)]))[0];
    },

    /** Approve (advances a step; the last step books the leave) or reject (needs a comment). */
    async decide(ctx, requestId, { decision, comment }) {
      if (decision === 'REJECT' && !comment) throw new ValidationError([{ path: 'body.comment', message: 'Say why the request was rejected' }]);
      return withTransaction(prisma, async (tx) => {
        const r = await tx.leaveRequest.findFirst({ where: { organizationId: ctx.orgId, id: requestId } });
        if (!r) throw new NotFoundError('Leave request not found');
        await lockMember(tx, ctx.orgId, r.userId);
        const fresh = await tx.leaveRequest.findFirst({ where: { organizationId: ctx.orgId, id: requestId } });
        if (fresh.status !== 'PENDING') throw new ConflictError(`This request is already ${fresh.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
        if (fresh.userId === ctx.userId) throw new ForbiddenError('You cannot decide your own leave');
        const step = fresh.chain[fresh.currentStep];
        if (!step.approverIds.includes(ctx.userId) && !hasOrgScope(ctx, 'leave.approve')) throw new ForbiddenError('You are not an approver for this step');
        const now = clock.now();
        await tx.leaveApproval.create({ data: { organizationId: ctx.orgId, leaveRequestId: fresh.id, step: fresh.currentStep, actorId: ctx.userId, action: decision, comment: comment ?? null, createdAt: now } });
        const last = fresh.currentStep >= fresh.chain.length - 1;
        if (decision === 'REJECT') {
          await tx.leaveRequest.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: fresh.id } }, data: { status: 'REJECTED', decidedAt: now, version: { increment: 1 } } });
          await notifyRequester(tx, ctx, fresh, 'rejected', comment);
        } else if (!last) {
          const updated = await tx.leaveRequest.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: fresh.id } }, data: { currentStep: { increment: 1 }, version: { increment: 1 } } });
          const requester = await memberSummaries(tx, ctx.orgId, [fresh.userId]);
          await notifyApprovers(tx, ctx, updated, fresh.chain[updated.currentStep], requester.get(fresh.userId)?.name ?? 'Someone');
        } else {
          await tx.leaveRequest.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: fresh.id } }, data: { status: 'APPROVED', decidedAt: now, version: { increment: 1 } } });
          await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'leave.approved', data: { leaveRequestId: fresh.id, startDate: isoDate(fresh.startDate), endDate: isoDate(fresh.endDate), days: days(fresh.days) } });
          await tx.leaveLedgerEntry.create({
            data: { organizationId: ctx.orgId, userId: fresh.userId, leaveTypeId: fresh.leaveTypeId, entryType: 'USAGE', days: new D(fresh.days).negated(), effectiveDate: fresh.startDate, leaveRequestId: fresh.id, idempotencyKey: `usage:${fresh.id}`, createdById: ctx.userId },
          });
          await touchDays(tx, ctx, fresh);
          await notifyRequester(tx, ctx, fresh, 'approved', comment);
        }
        await recordAudit(tx, ctx, { action: `leave.${decision === 'REJECT' ? 'rejected' : last ? 'approved' : 'step_approved'}`, targetType: 'leave_request', targetId: fresh.id, diff: { step: fresh.currentStep, comment } });
        return (await serialize(tx, ctx, [await loadRequest(tx, ctx, fresh.id)]))[0];
      });
    },

    /**
     * Cancels a request. Pending: the requester or an approver. Approved: the requester before it
     * starts, or HR at any time; the days go back to the balance through a reversal entry.
     */
    async cancel(ctx, requestId, { comment }) {
      return withTransaction(prisma, async (tx) => {
        const r = await tx.leaveRequest.findFirst({ where: { organizationId: ctx.orgId, id: requestId } });
        if (!r) throw new NotFoundError('Leave request not found');
        await lockMember(tx, ctx.orgId, r.userId);
        const fresh = await tx.leaveRequest.findFirst({ where: { organizationId: ctx.orgId, id: requestId } });
        const own = fresh.userId === ctx.userId;
        const hr = hasOrgScope(ctx, 'leave.approve') && !own;
        if (!['PENDING', 'APPROVED'].includes(fresh.status)) throw new ConflictError(`A ${fresh.status.toLowerCase()} request cannot be cancelled`, ERROR_CODES.INVALID_STATE_TRANSITION);
        if (!own && !hr && !(fresh.status === 'PENDING' && fresh.chain[fresh.currentStep]?.approverIds.includes(ctx.userId))) throw new NotFoundError('Leave request not found');
        if (fresh.status === 'APPROVED' && own && isoDate(fresh.startDate) <= today(ctx)) throw new BusinessRuleError('Leave that has started can only be cancelled by HR');
        await tx.leaveRequest.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: fresh.id } }, data: { status: 'CANCELLED', decidedAt: clock.now(), version: { increment: 1 } } });
        await tx.leaveApproval.create({ data: { organizationId: ctx.orgId, leaveRequestId: fresh.id, step: fresh.currentStep, actorId: ctx.userId, action: 'CANCEL', comment: comment ?? null, createdAt: clock.now() } });
        if (fresh.status === 'APPROVED') {
          await tx.leaveLedgerEntry.create({
            data: { organizationId: ctx.orgId, userId: fresh.userId, leaveTypeId: fresh.leaveTypeId, entryType: 'REVERSAL', days: fresh.days, effectiveDate: fresh.startDate, leaveRequestId: fresh.id, idempotencyKey: `reversal:${fresh.id}`, createdById: ctx.userId },
          });
          await touchDays(tx, ctx, fresh);
        }
        if (!own) await notifyRequester(tx, ctx, fresh, 'cancelled', comment);
        await recordAudit(tx, ctx, { action: 'leave.cancelled', targetType: 'leave_request', targetId: fresh.id, diff: { was: fresh.status, comment } });
        await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'leave.cancelled', data: { leaveRequestId: fresh.id } });
        return (await serialize(tx, ctx, [await loadRequest(tx, ctx, fresh.id)]))[0];
      });
    },

    /** Approved and pending leave of everyone in scope, for a team calendar. */
    async calendar(ctx, { from, to }) {
      const scope = await resolveMemberScope(prisma, ctx, 'leave.read');
      const rows = await prisma.leaveRequest.findMany({
        where: { organizationId: ctx.orgId, status: { in: ACTIVE }, startDate: { lte: dateOnly(to) }, endDate: { gte: dateOnly(from) }, ...(scope.all ? {} : { userId: { in: [...scope.userIds] } }) },
        orderBy: { startDate: 'asc' },
        take: 2000,
      });
      return serialize(prisma, ctx, rows);
    },
  };
}
