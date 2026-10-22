import { idSchema, isoDateTimeSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { PERMISSIONS_BY_KEY } from '../rbac/permission-catalog.js';

const text = (max) => z.string().trim().min(1).max(max);
const events = z.array(z.string().max(64)).min(1).max(50);
const hookParams = z.object({ webhookId: idSchema }).strict();

export function integrationRoutes({ webhookService, apiKeyService, auditService, cursorCodec }) {
  const tags = ['Integrations'];
  return defineRoutes('', (r) => {
    r.get('/webhooks/events', { permission: 'webhooks.manage', tags, summary: 'Events you can subscribe to' }, (req, res) => sendOk(res, webhookService.events()));
    r.get('/webhooks', { permission: 'webhooks.manage', tags, summary: 'Webhooks' }, async (req, res) => sendOk(res, await webhookService.list(req.ctx)));
    r.post('/webhooks', { permission: 'webhooks.manage', body: z.object({ url: z.string().max(2048), events, description: text(200).optional() }).strict(), tags, summary: 'Add a webhook (the signing secret is shown once)' }, async (req, res) => {
      sendCreated(res, await webhookService.create(req.ctx, req.valid.body));
    });
    r.patch('/webhooks/:webhookId', { permission: 'webhooks.manage', params: hookParams, body: z.object({ url: z.string().max(2048), events, description: text(200).nullable(), isActive: z.boolean() }).partial().strict(), tags, summary: 'Update or (re)enable a webhook' }, async (req, res) => {
      sendOk(res, await webhookService.update(req.ctx, req.valid.params.webhookId, req.valid.body));
    });
    r.delete('/webhooks/:webhookId', { permission: 'webhooks.manage', params: hookParams, tags, summary: 'Delete a webhook' }, async (req, res) => {
      await webhookService.remove(req.ctx, req.valid.params.webhookId);
      sendNoContent(res);
    });
    r.post('/webhooks/:webhookId/rotate-secret', { permission: 'webhooks.manage', params: hookParams, tags, summary: 'New signing secret (shown once)' }, async (req, res) => {
      sendOk(res, await webhookService.rotateSecret(req.ctx, req.valid.params.webhookId));
    });
    r.post('/webhooks/:webhookId/ping', { permission: 'webhooks.manage', params: hookParams, tags, summary: 'Send a test event' }, async (req, res) => {
      sendCreated(res, await webhookService.ping(req.ctx, req.valid.params.webhookId));
    });
    r.get('/webhooks/:webhookId/deliveries', { permission: 'webhooks.manage', params: hookParams, tags, summary: 'Recent deliveries with status codes and errors' }, async (req, res) => {
      sendOk(res, await webhookService.deliveries(req.ctx, req.valid.params.webhookId));
    });
    r.post('/webhooks/:webhookId/deliveries/:deliveryId/replay', { permission: 'webhooks.manage', params: z.object({ webhookId: idSchema, deliveryId: idSchema }).strict(), tags, summary: 'Send an event again (new delivery id and signature)' }, async (req, res) => {
      sendCreated(res, await webhookService.replay(req.ctx, req.valid.params.webhookId, req.valid.params.deliveryId));
    });

    // Anyone may hold API keys for their own integrations (limited to their own permissions);
    // apikeys.manage sees and revokes everyone's.
    r.get('/api-keys', { permission: MEMBER, query: z.object({ mine: z.enum(['true', 'false']).optional() }).strict(), tags, summary: 'API keys (mine, or all with apikeys.manage)' }, async (req, res) => {
      sendOk(res, await apiKeyService.list(req.ctx, { mine: req.valid.query.mine === 'true' }));
    });
    r.post('/api-keys', { permission: 'apikeys.manage', body: z.object({ name: text(120), scopes: z.array(z.enum([...PERMISSIONS_BY_KEY.keys()])).min(1).max(200), expiresInDays: z.number().int().min(1).max(730).optional() }).strict(), tags, summary: 'Create an API key (shown once; scopes ⊆ your permissions)' }, async (req, res) => {
      sendCreated(res, await apiKeyService.create(req.ctx, req.valid.body));
    });
    r.post('/api-keys/:keyId/revoke', { permission: MEMBER, params: z.object({ keyId: idSchema }).strict(), tags, summary: 'Revoke an API key (mine, or any with apikeys.manage)' }, async (req, res) => {
      await apiKeyService.revoke(req.ctx, req.valid.params.keyId);
      sendNoContent(res);
    });

    r.get('/audit-logs', {
      permission: 'audit.read',
      query: z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), action: z.string().trim().max(64).optional(), actorId: idSchema.optional(), targetType: z.string().max(48).optional(), targetId: z.string().max(64).optional(), from: isoDateTimeSchema.optional(), to: isoDateTimeSchema.optional() }).strict(),
      tags: ['Audit'],
      summary: 'Audit trail (cursor; filter by action prefix, actor, target, time)',
    }, async (req, res) => {
      const { items, nextCursor } = await auditService.list(req.ctx, req.valid.query, cursorCodec);
      sendOk(res, items, { meta: { page: { nextCursor, limit: req.valid.query.limit } } });
    });
  });
}
