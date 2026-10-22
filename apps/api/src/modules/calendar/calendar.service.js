import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { dateOnly, isoDate } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { memberSummaries, resolveEmployeeUserIds } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { readableProjectsWhere } from '../projects/access.js';
import { hasPermission, resolveMemberScope } from '../rbac/rbac.service.js';

export const CALENDAR_SOURCES = ['holidays', 'leave', 'milestones', 'tasks', 'meetings'];
const MAX_RANGE_DAYS = 93;

/**
 * The unified calendar is a read model: each source comes from its own table and is filtered by
 * the caller's access, then normalized into { source, title, start, end, allDay, link }.
 */
export function createCalendarService({ prisma, clock, cipher, env }) {
  async function meetingAccess(ctx, eventId) {
    const event = await prisma.calendarEvent.findFirst({ where: { organizationId: ctx.orgId, id: eventId }, include: { attendees: true } });
    if (!event || (event.createdById !== ctx.userId && !event.attendees.some((a) => a.userId === ctx.userId))) throw new NotFoundError('Event not found');
    return event;
  }

  async function serializeMeeting(event) {
    const people = await memberSummaries(prisma, event.organizationId, [event.createdById, ...event.attendees.map((a) => a.userId)]);
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
      location: event.location,
      projectId: event.projectId,
      organizer: people.get(event.createdById) ?? null,
      attendees: event.attendees.map((a) => people.get(a.userId)).filter(Boolean),
      cancelledAt: event.cancelledAt,
    };
  }

  return {
    async range(ctx, { from, to, sources }) {
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
        throw new ValidationError([{ path: 'query.to', message: `Ranges are limited to ${MAX_RANGE_DAYS} days` }]);
      }
      const want = new Set(sources ? sources.split(',') : CALENDAR_SOURCES);
      const start = dateOnly(from);
      const end = dateOnly(to);
      const endExclusive = new Date(end.getTime() + 86_400_000);
      const items = [];

      if (want.has('holidays')) {
        const rows = await prisma.holiday.findMany({ where: { organizationId: ctx.orgId, date: { gte: start, lte: end } } });
        items.push(...rows.map((h) => ({ id: `holiday:${h.id}`, source: 'holidays', title: h.name, start: isoDate(h.date), end: isoDate(h.date), allDay: true, link: null })));
      }
      if (want.has('leave') && (hasPermission(ctx, 'leave.read') || hasPermission(ctx, 'leave.self'))) {
        // Approved and pending leave of the people whose leave I may see (always my own).
        const scope = hasPermission(ctx, 'leave.read') ? await resolveMemberScope(prisma, ctx, 'leave.read') : { all: false, userIds: new Set([ctx.userId]) };
        const rows = await prisma.leaveRequest.findMany({
          where: { organizationId: ctx.orgId, status: { in: ['APPROVED', 'PENDING'] }, startDate: { lte: end }, endDate: { gte: start }, ...(scope.all ? {} : { userId: { in: [...scope.userIds] } }) },
          include: { leaveType: { select: { name: true } } },
          take: 1000,
        });
        const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.userId));
        items.push(
          ...rows.map((r) => ({
            id: `leave:${r.id}`,
            source: 'leave',
            title: `${people.get(r.userId)?.name ?? 'Someone'}: ${r.leaveType.name}${r.status === 'PENDING' ? ' (pending)' : ''}`,
            start: isoDate(r.startDate),
            end: isoDate(r.endDate),
            allDay: true,
            link: r.userId === ctx.userId ? '/leave' : '/leave?view=team',
          })),
        );
      }
      if (want.has('milestones')) {
        const rows = await prisma.milestone.findMany({
          where: { organizationId: ctx.orgId, dueDate: { gte: start, lte: end }, project: { ...readableProjectsWhere(ctx), archivedAt: null } },
          include: { project: { select: { id: true, code: true } } },
        });
        items.push(
          ...rows.map((m) => ({
            id: `milestone:${m.id}`,
            source: 'milestones',
            title: `${m.project.code}: ${m.name}`,
            start: isoDate(m.dueDate),
            end: isoDate(m.dueDate),
            allDay: true,
            done: Boolean(m.completedAt),
            link: `/projects/${m.project.id}/overview`,
          })),
        );
      }
      if (want.has('tasks')) {
        const rows = await prisma.task.findMany({
          where: {
            organizationId: ctx.orgId,
            archivedAt: null,
            dueDate: { gte: start, lte: end },
            project: { archivedAt: null },
            OR: [
              { assignees: { some: { userId: ctx.userId } } },
              { project: { OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] } },
            ],
          },
          include: { project: { select: { code: true } }, status: { select: { category: true } } },
          take: 1000,
        });
        items.push(
          ...rows.map((t) => ({
            id: `task:${t.id}`,
            source: 'tasks',
            title: `${t.project.code}-${t.number} ${t.title}`,
            start: isoDate(t.dueDate),
            end: isoDate(t.dueDate),
            allDay: true,
            done: ['DONE', 'CANCELLED'].includes(t.status.category),
            link: `/tasks/${t.id}`,
          })),
        );
      }
      if (want.has('meetings')) {
        const rows = await prisma.calendarEvent.findMany({
          where: {
            organizationId: ctx.orgId,
            cancelledAt: null,
            startAt: { lt: endExclusive },
            endAt: { gt: start },
            OR: [{ createdById: ctx.userId }, { attendees: { some: { userId: ctx.userId } } }],
          },
          take: 1000,
        });
        items.push(
          ...rows.map((e) => ({
            id: `meeting:${e.id}`,
            meetingId: e.id,
            source: 'meetings',
            title: e.title,
            start: e.allDay ? isoDate(e.startAt) : e.startAt.toISOString(),
            end: e.allDay ? isoDate(e.endAt) : e.endAt.toISOString(),
            allDay: e.allDay,
            link: null,
          })),
        );
      }
      return items.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.title.localeCompare(b.title));
    },

    async getMeeting(ctx, eventId) {
      return serializeMeeting(await meetingAccess(ctx, eventId));
    },

    async createMeeting(ctx, body) {
      if (new Date(body.endAt) <= new Date(body.startAt)) throw new ValidationError([{ path: 'body.endAt', message: 'The end must be after the start' }]);
      const id = await withTransaction(prisma, async (tx) => {
        const attendees = await resolveEmployeeUserIds(tx, ctx.orgId, body.attendeeEmployeeIds, 'body.attendeeEmployeeIds');
        const event = await tx.calendarEvent.create({
          data: {
            organizationId: ctx.orgId,
            title: body.title,
            description: body.description ?? null,
            startAt: new Date(body.startAt),
            endAt: new Date(body.endAt),
            allDay: body.allDay,
            location: body.location ?? null,
            projectId: body.projectId ?? null,
            createdById: ctx.userId,
          },
        });
        const userIds = [...new Set([ctx.userId, ...attendees.values()])];
        await tx.calendarEventAttendee.createMany({ data: userIds.map((userId) => ({ organizationId: ctx.orgId, eventId: event.id, userId })) });
        for (const userId of userIds) {
          if (userId === ctx.userId) continue;
          await notify(tx, ctx, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: ctx.orgId,
            recipientUserId: userId,
            type: 'calendar.invited',
            title: `${ctx.user?.name ?? 'Someone'} invited you to “${event.title}”`,
            body: event.startAt.toISOString(),
            link: '/calendar',
            subjectType: 'calendar_event',
            subjectId: event.id,
            dedupeKey: `calendar-invite:${event.id}:${userId}`,
          });
        }
        await recordAudit(tx, ctx, { action: 'calendar.event_created', targetType: 'calendar_event', targetId: event.id });
        return event.id;
      });
      return this.getMeeting(ctx, id);
    },

    async cancelMeeting(ctx, eventId) {
      const event = await meetingAccess(ctx, eventId);
      if (event.createdById !== ctx.userId) throw new ForbiddenError('Only the organizer can cancel this event');
      await prisma.calendarEvent.updateMany({ where: { organizationId: ctx.orgId, id: eventId }, data: { cancelledAt: clock.now() } });
      await recordAudit(prisma, ctx, { action: 'calendar.event_cancelled', targetType: 'calendar_event', targetId: eventId });
    },
  };
}
