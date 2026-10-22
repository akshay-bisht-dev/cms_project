import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { dateOnly, isoDate, localDate, localDateRange, periodFor } from '../../utils/time.js';
import { sha256 } from '../../services/crypto.js';
import { recordAudit } from '../../services/audit.js';
import { recordActivity } from '../activity/activity.js';
import { withTransaction } from '../../repositories/tx.js';
import { coversMember, hasOrgScope, memberCanActOn, resolveMemberScope } from '../rbac/rbac.service.js';
import { memberCalendar } from '../attendance/schedule.js';
import { notify } from '../notifications/notifications.service.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

const EDITABLE = ['DRAFT', 'REJECTED'];
const invalid = (message) => new ConflictError(message, ERROR_CODES.INVALID_STATE_TRANSITION);

/** Fingerprint of the exact entries (and their versions) a decision is based on. */
function entriesHash(entries) {
  return sha256(entries.map((e) => `${e.id}:${e.version}:${e.durationS}`).sort().join('|'));
}

export function createTimesheetService({ prisma, clock, cipher, env }) {
  async function people(organizationId, userIds) {
    const rows = await prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: [...new Set(userIds)] } },
      select: { id: true, userId: true, user: { select: { name: true } } },
    });
    return new Map(rows.map((m) => [m.userId, { employeeId: m.id, name: m.user.name }]));
  }

  function serialize(sheet, owners) {
    return {
      id: sheet.id,
      employee: owners?.get(sheet.userId) ?? null,
      periodStart: isoDate(sheet.periodStart),
      periodEnd: isoDate(sheet.periodEnd),
      status: sheet.status,
      totalS: sheet.totalS,
      billableS: sheet.billableS,
      submittedAt: sheet.submittedAt,
      decidedAt: sheet.decidedAt,
      version: sheet.version,
    };
  }

  async function findSheet(db, organizationId, id) {
    const sheet = await db.timesheet.findFirst({ where: { organizationId, id } });
    if (!sheet) throw new NotFoundError('Timesheet not found');
    return sheet;
  }

  async function lockSheet(tx, organizationId, id) {
    await tx.$queryRaw`SELECT id FROM timesheets WHERE organization_id = ${organizationId} AND id = ${id} FOR UPDATE`;
    return findSheet(tx, organizationId, id);
  }

  async function linkedEntries(tx, organizationId, timesheetId) {
    const links = await tx.timesheetEntry.findMany({ where: { organizationId, timesheetId }, include: { entry: true } });
    return links.map((l) => l.entry).filter((e) => !e.deletedAt);
  }

  /** Re-collects eligible entries into a draft and recomputes its totals. */
  async function refresh(tx, sheet) {
    const { zone } = await memberCalendar(tx, sheet.organizationId, sheet.userId);
    const [start, end] = localDateRange(isoDate(sheet.periodStart), isoDate(sheet.periodEnd), zone);
    const eligible = await tx.timeEntry.findMany({
      where: { organizationId: sheet.organizationId, userId: sheet.userId, deletedAt: null, endedAt: { not: null }, startedAt: { gte: start, lt: end } },
      select: { id: true },
    });
    if (eligible.length) {
      // skipDuplicates + UNIQUE(organization_id, time_entry_id): entries already counted elsewhere stay there.
      await tx.timesheetEntry.createMany({
        data: eligible.map((e) => ({ organizationId: sheet.organizationId, timesheetId: sheet.id, timeEntryId: e.id })),
        skipDuplicates: true,
      });
    }
    const entries = await linkedEntries(tx, sheet.organizationId, sheet.id);
    const totalS = entries.reduce((s, e) => s + e.durationS, 0);
    const billableS = entries.filter((e) => e.isBillable).reduce((s, e) => s + e.durationS, 0);
    const updated = await tx.timesheet.update({
      where: { organizationId_id: { organizationId: sheet.organizationId, id: sheet.id } },
      data: { totalS, billableS },
    });
    return { sheet: updated, entries };
  }

  async function appendHistory(tx, ctx, sheet, action, comment, entries) {
    await tx.timesheetApproval.create({
      data: {
        organizationId: ctx.orgId,
        timesheetId: sheet.id,
        action,
        actorId: ctx.userId,
        comment: comment ?? null,
        snapshot: { totalS: sheet.totalS, billableS: sheet.billableS, entryCount: entries.length, entriesHash: entriesHash(entries) },
      },
    });
  }

  async function setLock(tx, organizationId, entries, locked) {
    if (!entries.length) return;
    await tx.timeEntry.updateMany({
      where: { organizationId, id: { in: entries.map((e) => e.id) } },
      data: { lockedAt: locked ? clock.now() : null },
    });
  }

  async function assertCanRead(db, ctx, sheet) {
    if (!(await coversMember(db, ctx, 'timesheets.read', sheet.userId))) throw new NotFoundError('Timesheet not found');
  }

  async function assertCanDecide(db, ctx, sheet) {
    if (sheet.userId === ctx.userId) throw new ForbiddenError('You cannot approve or reject your own timesheet');
    if (!(await coversMember(db, ctx, 'timesheets.approve', sheet.userId))) throw new ForbiddenError();
  }

  return {
    /** Gets or creates the caller's timesheet for the period containing `date` (default: today). */
    async open(ctx, { date }) {
      const { zone } = await memberCalendar(prisma, ctx.orgId, ctx.userId);
      const day = date ?? localDate(clock.now(), zone);
      const period = periodFor(day, ctx.orgSettings?.timeTracking?.timesheetPeriod ?? 'WEEKLY', ctx.organization?.weekStart ?? 1);
      return withTransaction(prisma, async (tx) => {
        await tx.timesheet.createMany({
          data: [{ organizationId: ctx.orgId, userId: ctx.userId, periodStart: dateOnly(period.start), periodEnd: dateOnly(period.end) }],
          skipDuplicates: true,
        });
        const sheet = await tx.timesheet.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, periodStart: dateOnly(period.start) } });
        const current = EDITABLE.includes(sheet.status) ? (await refresh(tx, sheet)).sheet : sheet;
        return serialize(current);
      });
    },

    async list(ctx, { view, status, employeeId }) {
      const where = { organizationId: ctx.orgId, ...(status ? { status } : {}) };
      if (view === 'approvals') {
        const scope = await resolveMemberScope(prisma, ctx, 'timesheets.approve');
        where.status = status ?? 'SUBMITTED';
        where.userId = scope.all ? { not: ctx.userId } : { in: [...scope.userIds].filter((id) => id !== ctx.userId) };
      } else if (employeeId) {
        const member = await prisma.organizationMember.findFirst({ where: { organizationId: ctx.orgId, id: employeeId } });
        if (!member || !(await coversMember(prisma, ctx, 'timesheets.read', member.userId))) throw new NotFoundError('Employee not found');
        where.userId = member.userId;
      } else {
        where.userId = ctx.userId;
      }
      const sheets = await prisma.timesheet.findMany({ where, orderBy: { periodStart: 'desc' }, take: 200 });
      const owners = await people(ctx.orgId, sheets.map((s) => s.userId));
      return sheets.map((s) => serialize(s, owners));
    },

    async get(ctx, id) {
      const sheet = await findSheet(prisma, ctx.orgId, id);
      await assertCanRead(prisma, ctx, sheet);
      const [entries, history, owners] = await Promise.all([
        linkedEntries(prisma, ctx.orgId, id),
        prisma.timesheetApproval.findMany({ where: { organizationId: ctx.orgId, timesheetId: id }, orderBy: { createdAt: 'asc' } }),
        people(ctx.orgId, [sheet.userId]),
      ]);
      const actors = await people(ctx.orgId, history.map((h) => h.actorId));
      const canDecide = sheet.status === 'SUBMITTED' && sheet.userId !== ctx.userId && (await coversMember(prisma, ctx, 'timesheets.approve', sheet.userId));
      return {
        ...serialize(sheet, owners),
        entries: entries
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((e) => ({ id: e.id, startedAt: e.startedAt, endedAt: e.endedAt, durationS: e.durationS, description: e.description, isBillable: e.isBillable })),
        history: history.map((h) => ({ action: h.action, actor: actors.get(h.actorId) ?? null, comment: h.comment, snapshot: h.snapshot, createdAt: h.createdAt })),
        actions: {
          canSubmit: sheet.userId === ctx.userId && EDITABLE.includes(sheet.status),
          canDecide,
          canReopen: sheet.status === 'APPROVED' && hasOrgScope(ctx, 'timesheets.unlock'),
        },
      };
    },

    async submit(ctx, id) {
      return withTransaction(prisma, async (tx) => {
        const locked = await lockSheet(tx, ctx.orgId, id);
        if (locked.userId !== ctx.userId) throw new ForbiddenError('You can only submit your own timesheet');
        if (!EDITABLE.includes(locked.status)) throw invalid(`A ${locked.status.toLowerCase()} timesheet cannot be submitted`);
        const { sheet, entries } = await refresh(tx, locked);
        if (entries.length === 0) throw new BusinessRuleError('There is no tracked time in this period to submit');
        await setLock(tx, ctx.orgId, entries, true);
        const submitted = await tx.timesheet.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id } },
          data: { status: 'SUBMITTED', submittedAt: clock.now(), decidedAt: null, decidedById: null, version: { increment: 1 } },
        });
        await appendHistory(tx, ctx, submitted, 'SUBMIT', null, entries);
        await recordAudit(tx, ctx, { action: 'timesheets.submitted', targetType: 'timesheet', targetId: id, diff: { totalS: sheet.totalS } });
        await recordActivity(tx, { organizationId: ctx.orgId, userId: ctx.userId, type: 'timesheet.submitted', occurredAt: clock.now(), subjectType: 'timesheet', subjectId: id });
        const { managerUserId } = await memberCalendar(tx, ctx.orgId, ctx.userId);
        if (await memberCanActOn(tx, ctx.orgId, managerUserId, 'timesheets.approve', ctx.userId)) {
          await notify(tx, ctx, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: ctx.orgId,
            recipientUserId: managerUserId,
            type: 'timesheets.submitted',
            title: `${ctx.user.name} submitted a timesheet`,
            body: `${isoDate(sheet.periodStart)} – ${isoDate(sheet.periodEnd)}`,
            link: `/timesheets/${id}`,
            subjectType: 'timesheet',
            subjectId: id,
            dedupeKey: `timesheet-submitted:${id}:${submitted.version}`,
          });
        }
        return serialize(submitted);
      });
    },

    async decide(ctx, id, { decision, comment }) {
      return withTransaction(prisma, async (tx) => {
        const sheet = await lockSheet(tx, ctx.orgId, id);
        await assertCanDecide(tx, ctx, sheet);
        if (sheet.status !== 'SUBMITTED') throw invalid(`A ${sheet.status.toLowerCase()} timesheet cannot be ${decision === 'APPROVED' ? 'approved' : 'rejected'}`);
        const entries = await linkedEntries(tx, ctx.orgId, id);
        const [submission] = await tx.timesheetApproval.findMany({
          where: { organizationId: ctx.orgId, timesheetId: id, action: 'SUBMIT' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        });
        if (submission?.snapshot?.entriesHash !== entriesHash(entries)) {
          throw new ConflictError('The entries changed after submission; ask for a resubmission', 'STALE_TIMESHEET');
        }
        if (decision === 'REJECTED') await setLock(tx, ctx.orgId, entries, false);
        const decided = await tx.timesheet.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id } },
          data: { status: decision, decidedAt: clock.now(), decidedById: ctx.userId, version: { increment: 1 } },
        });
        await appendHistory(tx, ctx, decided, decision === 'APPROVED' ? 'APPROVE' : 'REJECT', comment, entries);
        await recordAudit(tx, ctx, { action: `timesheets.${decision.toLowerCase()}`, targetType: 'timesheet', targetId: id, diff: { comment } });
        if (decision === 'APPROVED') await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'timesheet.approved', data: { timesheetId: id, periodStart: isoDate(sheet.periodStart) } });
        await recordActivity(tx, { organizationId: ctx.orgId, userId: sheet.userId, type: decision === 'APPROVED' ? 'timesheet.approved' : 'timesheet.rejected', occurredAt: clock.now(), subjectType: 'timesheet', subjectId: id, metadata: { actorId: ctx.userId } });
        await notify(tx, ctx, {
          cipher,
          appOrigin: env.APP_ORIGIN,
          organizationId: ctx.orgId,
          recipientUserId: sheet.userId,
          type: 'timesheets.decided',
          title: `Your timesheet for ${isoDate(sheet.periodStart)} was ${decision.toLowerCase()}`,
          body: comment ?? null,
          link: `/timesheets/${id}`,
          subjectType: 'timesheet',
          subjectId: id,
          dedupeKey: `timesheet-decided:${id}:${decided.version}`,
        });
        return serialize(decided);
      });
    },

    async reopen(ctx, id, { comment }) {
      return withTransaction(prisma, async (tx) => {
        const sheet = await lockSheet(tx, ctx.orgId, id);
        if (sheet.status !== 'APPROVED') throw invalid('Only approved timesheets can be reopened');
        const entries = await linkedEntries(tx, ctx.orgId, id);
        await setLock(tx, ctx.orgId, entries, false);
        const reopened = await tx.timesheet.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id } },
          data: { status: 'DRAFT', decidedAt: null, decidedById: null, version: { increment: 1 } },
        });
        await appendHistory(tx, ctx, reopened, 'REOPEN', comment, entries);
        await recordAudit(tx, ctx, { action: 'timesheets.reopened', targetType: 'timesheet', targetId: id, diff: { comment } });
        return serialize(reopened);
      });
    },

    /** Data for exports; the caller must be able to read the timesheet. */
    async exportData(ctx, id) {
      const detail = await this.get(ctx, id);
      await recordAudit(prisma, ctx, { action: 'timesheets.exported', targetType: 'timesheet', targetId: id });
      return detail;
    },
  };
}
