import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { enqueueEmail } from '../../services/email.js';
import { fitKey } from '../../services/outbox.js';
import { NOTIFICATION_TYPES } from './notification-types.js';

/**
 * Creates a notification inside the caller's transaction, honouring the recipient's channel
 * preferences. The real-time push is deferred to ctx.afterCommit, which runs only when the
 * request succeeds, so subscribers never hear about changes that rolled back.
 */
export async function notify(db, ctx, { cipher, appOrigin, organizationId, recipientUserId, type, title, body = null, link = null, subjectType = null, subjectId = null, dedupeKey }) {
  const def = NOTIFICATION_TYPES[type];
  if (!def) throw new Error(`Unknown notification type "${type}"`);
  const pref = await db.notificationPreference.findUnique({
    where: { organizationId_userId_type: { organizationId, userId: recipientUserId, type } },
  });
  const inApp = pref?.inApp ?? true;
  const email = pref?.email ?? def.email;

  let notification = null;
  if (inApp) {
    try {
      notification = await db.notification.create({
        data: { organizationId, recipientUserId, type, title, body, link, subjectType, subjectId, dedupeKey: fitKey(dedupeKey) },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err; // duplicate dedupe key: already notified
      return null;
    }
    ctx?.afterCommit?.push((realtime) => realtime.emitToMember(organizationId, recipientUserId, 'notification.created', { id: notification.id, type }));
  }
  if (email) {
    const recipient = await db.user.findUnique({ where: { id: recipientUserId }, select: { email: true, name: true } });
    await enqueueEmail(db, cipher, {
      to: recipient.email,
      template: 'notification',
      organizationId,
      data: { name: recipient.name, title, body },
      link: link ? `${appOrigin}${link}` : undefined,
      dedupeKey: `notification-email:${organizationId}:${recipientUserId}:${dedupeKey}`,
    });
  }
  return notification;
}

export function createNotificationService({ prisma, clock, cursorCodec }) {
  const serialize = (n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    subjectType: n.subjectType,
    subjectId: n.subjectId,
    readAt: n.readAt,
    createdAt: n.createdAt,
  });

  return {
    async list(ctx, { cursor, limit, unreadOnly }) {
      const where = { organizationId: ctx.orgId, recipientUserId: ctx.userId };
      if (unreadOnly === 'true') where.readAt = null;
      if (cursor) {
        const c = cursorCodec.decode(cursor, 'notifications');
        where.OR = [{ createdAt: { lt: new Date(c.v) } }, { createdAt: new Date(c.v), id: { lt: c.id } }];
      }
      const rows = await prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? page.at(-1) : null;
      return {
        items: page.map(serialize),
        nextCursor: next ? cursorCodec.encode({ sort: 'notifications', v: next.createdAt.toISOString(), id: next.id }) : null,
      };
    },

    unreadCount(ctx) {
      return prisma.notification.count({ where: { organizationId: ctx.orgId, recipientUserId: ctx.userId, readAt: null } });
    },

    async markRead(ctx, id) {
      const { count } = await prisma.notification.updateMany({
        where: { organizationId: ctx.orgId, recipientUserId: ctx.userId, id },
        data: { readAt: clock.now() },
      });
      if (count === 0) throw new NotFoundError('Notification not found');
    },

    async markAllRead(ctx) {
      const { count } = await prisma.notification.updateMany({
        where: { organizationId: ctx.orgId, recipientUserId: ctx.userId, readAt: null },
        data: { readAt: clock.now() },
      });
      return { updated: count };
    },

    async getPreferences(ctx) {
      const rows = await prisma.notificationPreference.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId } });
      const byType = new Map(rows.map((r) => [r.type, r]));
      return Object.entries(NOTIFICATION_TYPES).map(([type, def]) => ({
        type,
        label: def.label,
        inApp: byType.get(type)?.inApp ?? true,
        email: byType.get(type)?.email ?? def.email,
      }));
    },

    async setPreferences(ctx, preferences) {
      const unknown = preferences.filter((p) => !NOTIFICATION_TYPES[p.type]);
      if (unknown.length) throw new ValidationError([{ path: 'body.preferences', message: `Unknown types: ${unknown.map((p) => p.type).join(', ')}` }]);
      await prisma.$transaction(
        preferences.map((p) =>
          prisma.notificationPreference.upsert({
            where: { organizationId_userId_type: { organizationId: ctx.orgId, userId: ctx.userId, type: p.type } },
            update: { inApp: p.inApp, email: p.email },
            create: { organizationId: ctx.orgId, userId: ctx.userId, type: p.type, inApp: p.inApp, email: p.email },
          }),
        ),
      );
      return this.getPreferences(ctx);
    },
  };
}
