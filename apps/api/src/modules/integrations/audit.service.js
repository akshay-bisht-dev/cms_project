import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';

/** Read side of the append-only audit log (writes go through services/audit.js). */
export function createAuditService({ prisma }) {
  return {
    async list(ctx, { cursor, limit, action, actorId, targetType, targetId, from, to }, cursorCodec) {
      const where = { organizationId: ctx.orgId };
      if (action) where.action = { startsWith: action };
      if (actorId) where.actorId = await resolveEmployeeUserId(prisma, ctx.orgId, actorId, 'query.actorId');
      if (targetType) where.targetType = targetType;
      if (targetId) where.targetId = targetId;
      if (from || to) where.at = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(to) } : {}) };
      if (cursor) {
        const c = cursorCodec.decode(cursor, 'at');
        where.OR = [{ at: { lt: new Date(c.at) } }, { at: new Date(c.at), id: { lt: c.id } }];
      }
      const rows = await prisma.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = rows.slice(0, limit);
      const people = await memberSummaries(prisma, ctx.orgId, page.filter((r) => r.actorType === 'USER').map((r) => r.actorId));
      const keyIds = page.filter((r) => r.actorType === 'API_KEY').map((r) => r.actorId);
      const keys = new Map(keyIds.length ? (await prisma.apiKey.findMany({ where: { organizationId: ctx.orgId, id: { in: keyIds } }, select: { id: true, name: true } })).map((k) => [k.id, k.name]) : []);
      const actor = (r) => {
        if (r.actorType === 'USER') return { type: 'USER', name: people.get(r.actorId)?.name ?? 'Former member', id: people.get(r.actorId)?.employeeId ?? null };
        if (r.actorType === 'API_KEY') return { type: 'API_KEY', name: `API key “${keys.get(r.actorId) ?? 'deleted'}”` };
        return { type: r.actorType, name: r.actorType === 'AGENT' ? 'Desktop agent' : 'System' };
      };
      const last = page.at(-1);
      return {
        items: page.map((r) => ({ id: r.id, at: r.at, action: r.action, actor: actor(r), targetType: r.targetType, targetId: r.targetId, diff: r.diff, ip: r.ip, requestId: r.requestId })),
        nextCursor: rows.length > limit && last ? cursorCodec.encode({ sort: 'at', at: last.at.toISOString(), id: last.id }) : null,
      };
    },
  };
}
