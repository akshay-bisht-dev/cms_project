import { idSchema, z } from '@orbit/validation';
import { MEMBER } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendNoContent, sendOk } from '../../utils/response.js';

const listQuery = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    unreadOnly: z.enum(['true', 'false']).default('false'),
  })
  .strict();
const idParams = z.object({ notificationId: idSchema }).strict();
const preferencesBody = z
  .object({ preferences: z.array(z.object({ type: z.string().max(64), inApp: z.boolean(), email: z.boolean() }).strict()).max(50) })
  .strict();

export function notificationRoutes({ notificationService }) {
  const tags = ['Notifications'];
  return defineRoutes('/notifications', (r) => {
    r.get('/', { permission: MEMBER, allowClient: true, query: listQuery, tags, summary: 'My notifications (newest first)' }, async (req, res) => {
      const { items, nextCursor } = await notificationService.list(req.ctx, req.valid.query);
      sendOk(res, items, { meta: { page: { nextCursor, limit: req.valid.query.limit } } });
    });
    r.get('/unread-count', { permission: MEMBER, allowClient: true, tags, summary: 'Number of unread notifications' }, async (req, res) => {
      sendOk(res, { count: await notificationService.unreadCount(req.ctx) });
    });
    r.post('/read-all', { permission: MEMBER, allowClient: true, tags, summary: 'Mark all notifications read' }, async (req, res) => {
      sendOk(res, await notificationService.markAllRead(req.ctx));
    });
    r.post('/:notificationId/read', { permission: MEMBER, allowClient: true, params: idParams, tags, summary: 'Mark one notification read' }, async (req, res) => {
      await notificationService.markRead(req.ctx, req.valid.params.notificationId);
      sendNoContent(res);
    });
    r.get('/preferences', { permission: MEMBER, allowClient: true, tags, summary: 'My notification preferences' }, async (req, res) => {
      sendOk(res, await notificationService.getPreferences(req.ctx));
    });
    r.put('/preferences', { permission: MEMBER, allowClient: true, body: preferencesBody, tags, summary: 'Update my notification preferences' }, async (req, res) => {
      sendOk(res, await notificationService.setPreferences(req.ctx, req.valid.body.preferences));
    });
  });
}
