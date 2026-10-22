import { ERROR_CODES } from '@orbit/shared-constants';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { nextSequence } from '../../services/sequences.js';
import { withTransaction } from '../../repositories/tx.js';
import { isoDate, isValidTimeZone } from '../../utils/time.js';
import { addBusinessMinutes } from '../../utils/business-time.js';
import { hasOrgScope } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT'];
export const DEFAULT_SLA_TARGETS = {
  URGENT: { firstResponseMin: 60, resolutionMin: 240 },
  HIGH: { firstResponseMin: 240, resolutionMin: 1440 },
  NORMAL: { firstResponseMin: 480, resolutionMin: 2880 },
  LOW: { firstResponseMin: 1440, resolutionMin: 7200 },
};

const TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED'],
  WAITING_CLIENT: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: ['OPEN'],
};

/** The organization's default SLA policy, created on first use. */
export async function ensureDefaultSla(db, organizationId) {
  const existing = await db.slaPolicy.findFirst({ where: { organizationId, isDefault: true, archivedAt: null } });
  return existing ?? db.slaPolicy.create({ data: { organizationId, name: 'Standard', isDefault: true, targets: DEFAULT_SLA_TARGETS } });
}

/** First-response and resolution deadlines for a ticket created at `from`. */
export async function slaDeadlines(db, organizationId, policy, priority, from) {
  if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null };
  const target = policy.targets?.[priority];
  if (!target) return { firstResponseDueAt: null, resolutionDueAt: null };
  const [schedule, org] = await Promise.all([
    policy.scheduleId ? db.workSchedule.findFirst({ where: { organizationId, id: policy.scheduleId } }) : null,
    db.organization.findUnique({ where: { id: organizationId }, select: { timeZone: true } }),
  ]);
  const zone = isValidTimeZone(schedule?.timeZone) ? schedule.timeZone : org.timeZone;
  const holidays = schedule ? (await db.holiday.findMany({ where: { organizationId, date: { gte: new Date(from.getTime() - 86_400_000) } }, select: { date: true } })).map((h) => isoDate(h.date)) : [];
  const opts = { schedule, zone, holidays };
  return { firstResponseDueAt: addBusinessMinutes(from, target.firstResponseMin, opts), resolutionDueAt: addBusinessMinutes(from, target.resolutionMin, opts) };
}

/**
 * Tickets visible with `key` (tickets.read / tickets.manage):
 * self = assigned to or reported by me; team = tickets of teams I lead; project = tickets of
 * projects I manage; org = all.
 */
export async function ticketScopeWhere(db, ctx, key) {
  if (hasOrgScope(ctx, key)) return { organizationId: ctx.orgId };
  const scopes = ctx.permissions?.get(key);
  if (!scopes?.size) return { organizationId: ctx.orgId, id: '__none__' };
  const or = [{ assigneeId: ctx.userId }, { reporterId: ctx.userId }];
  if (scopes.has('team')) {
    const teams = await db.team.findMany({ where: { organizationId: ctx.orgId, leadUserId: ctx.userId, archivedAt: null }, select: { id: true } });
    if (teams.length) or.push({ teamId: { in: teams.map((t) => t.id) } });
  }
  if (scopes.has('project')) {
    const projects = await db.project.findMany({ where: { organizationId: ctx.orgId, OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] }, select: { id: true } });
    if (projects.length) or.push({ projectId: { in: projects.map((p) => p.id) } });
  }
  return { organizationId: ctx.orgId, OR: or };
}

export function createTicketService({ prisma, clock, cipher, env }) {
  const notifyOpts = { cipher, appOrigin: env.APP_ORIGIN };

  async function serialize(db, ctx, t, { comments, portal = false } = {}) {
    const ids = [t.reporterId, t.assigneeId, ...(comments ?? []).map((c) => c.authorId)];
    const [people, team, project] = await Promise.all([
      memberSummaries(db, ctx.orgId, ids),
      !portal && t.teamId ? db.team.findFirst({ where: { organizationId: ctx.orgId, id: t.teamId }, select: { id: true, name: true } }) : null,
      t.projectId ? db.project.findFirst({ where: { organizationId: ctx.orgId, id: t.projectId }, select: { id: true, code: true, name: true } }) : null,
    ]);
    const person = (id) => (id && people.get(id) ? { id: people.get(id).employeeId, name: people.get(id).name } : null);
    const now = clock.now();
    const open = OPEN_STATUSES.includes(t.status);
    return {
      id: t.id,
      number: t.number,
      key: `T-${t.number}`,
      subject: t.subject,
      description: t.description,
      priority: t.priority,
      status: t.status,
      client: t.client ? { id: t.client.id, code: t.client.code, name: t.client.name } : null,
      project,
      reporter: person(t.reporterId),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      resolvedAt: t.resolvedAt,
      sla: {
        firstResponseDueAt: t.firstResponseDueAt,
        resolutionDueAt: t.resolutionDueAt,
        firstRespondedAt: t.firstRespondedAt,
        firstResponseBreached: t.firstResponseBreached || Boolean(!t.firstRespondedAt && t.firstResponseDueAt && t.firstResponseDueAt < now && open),
        breached: t.slaBreached || Boolean(open && t.resolutionDueAt && t.resolutionDueAt < now),
      },
      ...(portal
        ? {}
        : { assignee: person(t.assigneeId), team, slaPolicyId: t.slaPolicyId, version: t.version }),
      ...(comments
        ? { comments: comments.map((c) => ({ id: c.id, visibility: c.visibility, body: c.body, createdAt: c.createdAt, author: person(c.authorId) ?? { name: 'Former member' } })) }
        : {}),
    };
  }

  async function loadVisible(db, ctx, ticketId, key = 'tickets.read') {
    const where = await ticketScopeWhere(db, ctx, key);
    const ticket = await db.supportTicket.findFirst({ where: { AND: [where, { id: ticketId }] }, include: { client: true } });
    if (!ticket) throw new NotFoundError('Ticket not found');
    return ticket;
  }

  async function validateRefs(db, ctx, { clientId, projectId, teamId }) {
    if (clientId && !(await db.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } }))) throw new ValidationError([{ path: 'body.clientId', message: 'Client not found' }]);
    if (projectId) {
      const project = await db.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId } });
      if (!project) throw new ValidationError([{ path: 'body.projectId', message: 'Project not found' }]);
      if (clientId && project.clientId && project.clientId !== clientId) throw new ValidationError([{ path: 'body.projectId', message: 'The project belongs to another client' }]);
    }
    if (teamId && !(await db.team.findFirst({ where: { organizationId: ctx.orgId, id: teamId, archivedAt: null } }))) throw new ValidationError([{ path: 'body.teamId', message: 'Team not found' }]);
  }

  async function notifyAssignee(tx, ctx, ticket, assigneeId) {
    if (!assigneeId || assigneeId === ctx.userId) return;
    await notify(tx, ctx, {
      ...notifyOpts,
      organizationId: ctx.orgId,
      recipientUserId: assigneeId,
      type: 'tickets.assigned',
      title: `T-${ticket.number} assigned to you: ${ticket.subject}`,
      link: `/tickets/${ticket.id}`,
      subjectType: 'ticket',
      subjectId: ticket.id,
      dedupeKey: `ticket-assigned:${ticket.id}:${assigneeId}:${ticket.version}`,
    });
  }

  /** Creates a ticket (staff or portal). SLA deadlines come from the policy and its business hours. */
  async function createTicket(tx, ctx, { subject, description, priority = 'NORMAL', clientId = null, projectId = null, teamId = null, assigneeId = null, slaPolicyId = null }) {
    const policy = slaPolicyId
      ? await tx.slaPolicy.findFirst({ where: { organizationId: ctx.orgId, id: slaPolicyId, archivedAt: null } })
      : await ensureDefaultSla(tx, ctx.orgId);
    if (slaPolicyId && !policy) throw new ValidationError([{ path: 'body.slaPolicyId', message: 'SLA policy not found' }]);
    const now = clock.now();
    const number = await nextSequence(tx, ctx.orgId, 'TICKET');
    const ticket = await tx.supportTicket.create({
      data: { organizationId: ctx.orgId, number, subject, description, priority, clientId, projectId, teamId, assigneeId, reporterId: ctx.userId, slaPolicyId: policy?.id ?? null, ...(await slaDeadlines(tx, ctx.orgId, policy, priority, now)), createdAt: now },
      include: { client: true },
    });
    await recordAudit(tx, ctx, { action: 'tickets.created', targetType: 'ticket', targetId: ticket.id, diff: { number, priority, clientId } });
    await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'ticket.created', data: { ticketId: ticket.id, number, priority, clientId } });
    await notifyAssignee(tx, ctx, ticket, assigneeId);
    return ticket;
  }

  /** Adds a comment. The first public reply from staff records the first response. */
  async function addComment(tx, ctx, ticket, { body, visibility }, { fromClient = false } = {}) {
    const now = clock.now();
    const comment = await tx.ticketComment.create({ data: { organizationId: ctx.orgId, ticketId: ticket.id, authorId: ctx.userId, visibility, body, createdAt: now } });
    const data = {};
    if (visibility === 'PUBLIC' && !fromClient && !ticket.firstRespondedAt) {
      data.firstRespondedAt = now;
      data.firstResponseBreached = Boolean(ticket.firstResponseDueAt && now > ticket.firstResponseDueAt);
    }
    if (fromClient && ['WAITING_CLIENT', 'RESOLVED'].includes(ticket.status)) data.status = 'OPEN';
    if (Object.keys(data).length) await tx.supportTicket.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: ticket.id } }, data: { ...data, version: { increment: 1 } } });

    if (visibility === 'PUBLIC') {
      const recipient = fromClient ? ticket.assigneeId : ticket.reporterId;
      if (recipient && recipient !== ctx.userId) {
        await notify(tx, ctx, {
          ...notifyOpts,
          organizationId: ctx.orgId,
          recipientUserId: recipient,
          type: fromClient ? 'tickets.client_replied' : 'tickets.replied',
          title: `New reply on T-${ticket.number}: ${ticket.subject}`,
          body: body.slice(0, 200),
          link: fromClient ? `/tickets/${ticket.id}` : `/portal/tickets/${ticket.id}`,
          subjectType: 'ticket',
          subjectId: ticket.id,
          dedupeKey: `ticket-comment:${comment.id}`,
        });
      }
    }
    return comment;
  }

  return {
    createTicket,
    addComment,
    serialize,

    // ─── SLA policies ───────────────────────────────────────────────────────

    async slaPolicies(ctx) {
      await ensureDefaultSla(prisma, ctx.orgId);
      const rows = await prisma.slaPolicy.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
      return rows.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, targets: p.targets, scheduleId: p.scheduleId }));
    },

    async saveSlaPolicy(ctx, policyId, body) {
      if (!hasOrgScope(ctx, 'tickets.manage')) throw new ForbiddenError('Only organization-wide ticket managers can change SLA policies');
      if (body.scheduleId && !(await prisma.workSchedule.findFirst({ where: { organizationId: ctx.orgId, id: body.scheduleId, archivedAt: null } }))) {
        throw new ValidationError([{ path: 'body.scheduleId', message: 'Schedule not found' }]);
      }
      const saved = await withTransaction(prisma, async (tx) => {
        if (body.isDefault) await tx.slaPolicy.updateMany({ where: { organizationId: ctx.orgId }, data: { isDefault: false } });
        if (policyId) {
          const { count } = await tx.slaPolicy.updateMany({ where: { organizationId: ctx.orgId, id: policyId, archivedAt: null }, data: body });
          if (!count) throw new NotFoundError('SLA policy not found');
          return policyId;
        }
        return (await tx.slaPolicy.create({ data: { organizationId: ctx.orgId, ...body } })).id;
      });
      await recordAudit(prisma, ctx, { action: 'tickets.sla_policy_saved', targetType: 'sla_policy', targetId: saved, diff: body });
      return (await this.slaPolicies(ctx)).find((p) => p.id === saved);
    },

    // ─── tickets ────────────────────────────────────────────────────────────

    async list(ctx, { status, priority, clientId, assigneeId, mine, q, breached }) {
      const where = { AND: [await ticketScopeWhere(prisma, ctx, 'tickets.read')] };
      if (status) where.AND.push({ status: { in: status } });
      if (priority) where.AND.push({ priority: { in: priority } });
      if (clientId) where.AND.push({ clientId });
      if (assigneeId) where.AND.push({ assigneeId: await resolveEmployeeUserId(prisma, ctx.orgId, assigneeId, 'query.assigneeId') });
      if (mine) where.AND.push({ assigneeId: ctx.userId });
      if (breached) where.AND.push({ OR: [{ slaBreached: true }, { status: { in: OPEN_STATUSES }, resolutionDueAt: { lt: clock.now() } }] });
      if (q) where.AND.push({ OR: [{ subject: { contains: q } }, ...(/^\d+$/.test(q.replace(/^T-/i, '')) ? [{ number: Number(q.replace(/^T-/i, '')) }] : [])] });
      const rows = await prisma.supportTicket.findMany({ where, include: { client: true }, orderBy: [{ status: 'asc' }, { resolutionDueAt: 'asc' }], take: 500 });
      return Promise.all(rows.map((t) => serialize(prisma, ctx, t)));
    },

    async get(ctx, ticketId) {
      const ticket = await loadVisible(prisma, ctx, ticketId);
      const comments = await prisma.ticketComment.findMany({ where: { organizationId: ctx.orgId, ticketId: ticket.id }, orderBy: { createdAt: 'asc' } });
      return { ...(await serialize(prisma, ctx, ticket, { comments })), canManage: Boolean(await prisma.supportTicket.findFirst({ where: { AND: [await ticketScopeWhere(prisma, ctx, 'tickets.manage'), { id: ticket.id }] }, select: { id: true } })) };
    },

    async create(ctx, { assigneeId, ...body }) {
      return withTransaction(prisma, async (tx) => {
        await validateRefs(tx, ctx, body);
        const assignee = assigneeId ? await resolveEmployeeUserId(tx, ctx.orgId, assigneeId, 'body.assigneeId') : null;
        const ticket = await createTicket(tx, ctx, { ...body, assigneeId: assignee });
        return serialize(tx, ctx, ticket);
      });
    },

    async update(ctx, ticketId, { version, assigneeId, ...patch }) {
      return withTransaction(prisma, async (tx) => {
        const ticket = await loadVisible(tx, ctx, ticketId, 'tickets.manage');
        if (version !== undefined && version !== ticket.version) throw new ConflictError('This ticket changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        await validateRefs(tx, ctx, { clientId: patch.clientId ?? ticket.clientId, projectId: patch.projectId, teamId: patch.teamId });
        const now = clock.now();
        const data = { ...patch };
        if (assigneeId !== undefined) data.assigneeId = assigneeId ? await resolveEmployeeUserId(tx, ctx.orgId, assigneeId, 'body.assigneeId') : null;
        if (patch.status && patch.status !== ticket.status) {
          if (!TRANSITIONS[ticket.status].includes(patch.status)) throw new ConflictError(`A ${ticket.status.toLowerCase()} ticket cannot become ${patch.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
          if (patch.status === 'RESOLVED') {
            data.resolvedAt = now;
            data.slaBreached = ticket.slaBreached || Boolean(ticket.resolutionDueAt && now > ticket.resolutionDueAt);
          }
          if (patch.status === 'CLOSED') {
            data.closedAt = now;
            data.resolvedAt = ticket.resolvedAt ?? now;
            data.slaBreached = ticket.slaBreached || Boolean(!ticket.resolvedAt && ticket.resolutionDueAt && now > ticket.resolutionDueAt);
          }
          if (patch.status === 'OPEN') Object.assign(data, { resolvedAt: null, closedAt: null });
        }
        // A priority change re-targets the SLA from the ticket's creation.
        if (patch.priority && patch.priority !== ticket.priority) {
          const policy = ticket.slaPolicyId ? await tx.slaPolicy.findFirst({ where: { organizationId: ctx.orgId, id: ticket.slaPolicyId } }) : null;
          const due = await slaDeadlines(tx, ctx.orgId, policy, patch.priority, ticket.createdAt);
          if (!ticket.firstRespondedAt) data.firstResponseDueAt = due.firstResponseDueAt;
          data.resolutionDueAt = due.resolutionDueAt;
        }
        const updated = await tx.supportTicket.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: ticket.id } }, data: { ...data, version: { increment: 1 } }, include: { client: true } });
        await recordAudit(tx, ctx, { action: 'tickets.updated', targetType: 'ticket', targetId: ticket.id, diff: { changed: Object.keys(data), status: updated.status } });
        if (data.status === 'RESOLVED') await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'ticket.resolved', data: { ticketId: ticket.id, number: ticket.number, slaBreached: data.slaBreached } });
        if (data.assigneeId && data.assigneeId !== ticket.assigneeId) await notifyAssignee(tx, ctx, updated, data.assigneeId);
        return serialize(tx, ctx, updated);
      });
    },

    async comment(ctx, ticketId, { body, visibility }) {
      return withTransaction(prisma, async (tx) => {
        // Reading is enough for internal notes; replying to the client needs manage.
        const ticket = await loadVisible(tx, ctx, ticketId, visibility === 'PUBLIC' ? 'tickets.manage' : 'tickets.read');
        const comment = await addComment(tx, ctx, ticket, { body, visibility });
        return { id: comment.id };
      });
    },
  };
}

/**
 * Flags tickets whose SLA deadlines passed while still open and tells the assignee (or, when
 * unassigned, the team lead). Idempotent: each flag is set once.
 */
export async function checkSlaBreaches({ prisma, clock, cipher, env }) {
  const now = clock.now();
  const overdue = await prisma.unscoped.supportTicket.findMany({
    where: { status: { in: OPEN_STATUSES }, OR: [{ slaBreached: false, resolutionDueAt: { lt: now } }, { firstResponseBreached: false, firstRespondedAt: null, firstResponseDueAt: { lt: now } }] },
    take: 500,
  });
  for (const t of overdue) {
    const resolution = !t.slaBreached && t.resolutionDueAt && t.resolutionDueAt < now;
    await withTransaction(prisma, async (tx) => {
      await tx.supportTicket.updateMany({
        where: { organizationId: t.organizationId, id: t.id },
        data: { ...(resolution ? { slaBreached: true } : {}), ...(!t.firstRespondedAt && t.firstResponseDueAt < now ? { firstResponseBreached: true } : {}) },
      });
      const team = !t.assigneeId && t.teamId ? await tx.team.findFirst({ where: { organizationId: t.organizationId, id: t.teamId } }) : null;
      const recipient = t.assigneeId ?? team?.leadUserId;
      if (recipient) {
        await notify(tx, null, {
          cipher,
          appOrigin: env.APP_ORIGIN,
          organizationId: t.organizationId,
          recipientUserId: recipient,
          type: 'tickets.sla_breached',
          title: `T-${t.number} missed its ${resolution ? 'resolution' : 'first-response'} target`,
          link: `/tickets/${t.id}`,
          subjectType: 'ticket',
          subjectId: t.id,
          dedupeKey: `ticket-sla:${t.id}:${resolution ? 'resolution' : 'response'}`,
        });
      }
    });
  }
  return { flagged: overdue.length };
}
