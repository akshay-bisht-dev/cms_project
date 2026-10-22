import { idSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendOk } from '../../utils/response.js';

const text = (max) => z.string().trim().min(1).max(max);
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const status = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED']);
const list = (schema) => z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(schema));
const ticketParams = z.object({ ticketId: idSchema }).strict();
const listQuery = z
  .object({ status: list(status).optional(), priority: list(priority).optional(), clientId: idSchema.optional(), assigneeId: idSchema.optional(), mine: z.enum(['true', 'false']).optional(), breached: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional() })
  .strict();
const createBody = z
  .object({ subject: text(200), description: text(20_000), priority: priority.default('NORMAL'), clientId: idSchema.optional(), projectId: idSchema.optional(), teamId: idSchema.optional(), assigneeId: idSchema.optional(), slaPolicyId: idSchema.optional() })
  .strict();
const updateBody = z
  .object({ subject: text(200), description: text(20_000), priority, status, clientId: idSchema.nullable(), projectId: idSchema.nullable(), teamId: idSchema.nullable(), assigneeId: idSchema.nullable(), version: z.number().int().min(0) })
  .partial()
  .strict();
const commentBody = z.object({ body: text(20_000), visibility: z.enum(['INTERNAL', 'PUBLIC']) }).strict();
const target = z.object({ firstResponseMin: z.number().int().min(1).max(525_600), resolutionMin: z.number().int().min(1).max(525_600) }).strict();
const slaBody = z
  .object({ name: text(120), isDefault: z.boolean(), targets: z.object({ LOW: target, NORMAL: target, HIGH: target, URGENT: target }).strict(), scheduleId: idSchema.nullable() })
  .partial()
  .strict();
const slaParams = z.object({ policyId: idSchema }).strict();

export function ticketRoutes({ ticketService }) {
  const tags = ['Support tickets'];
  return defineRoutes('', (r) => {
    r.get('/support-tickets', { permission: 'tickets.read', apiKey: true, query: listQuery, tags, summary: 'Tickets in my scope' }, async (req, res) => {
      const q = req.valid.query;
      sendOk(res, await ticketService.list(req.ctx, { ...q, mine: q.mine === 'true', breached: q.breached === 'true' }));
    });
    r.post('/support-tickets', { permission: 'tickets.manage', apiKey: true, body: createBody, idempotent: true, tags, summary: 'Open a ticket (SLA deadlines from the policy)' }, async (req, res) => {
      sendCreated(res, await ticketService.create(req.ctx, req.valid.body));
    });
    r.get('/support-tickets/:ticketId', { permission: 'tickets.read', apiKey: true, params: ticketParams, tags, summary: 'Ticket with all comments' }, async (req, res) => {
      sendOk(res, await ticketService.get(req.ctx, req.valid.params.ticketId));
    });
    r.patch('/support-tickets/:ticketId', { permission: 'tickets.manage', params: ticketParams, body: updateBody, tags, summary: 'Update status, priority, assignment' }, async (req, res) => {
      sendOk(res, await ticketService.update(req.ctx, req.valid.params.ticketId, req.valid.body));
    });
    r.post('/support-tickets/:ticketId/comments', { permission: 'tickets.read', params: ticketParams, body: commentBody, tags, summary: 'Internal note, or a public reply to the client (needs manage)' }, async (req, res) => {
      sendCreated(res, await ticketService.comment(req.ctx, req.valid.params.ticketId, req.valid.body));
    });
    r.get('/sla-policies', { permission: 'tickets.read', tags, summary: 'SLA policies' }, async (req, res) => {
      sendOk(res, await ticketService.slaPolicies(req.ctx));
    });
    r.post('/sla-policies', { permission: 'tickets.manage', body: slaBody.required({ name: true, targets: true }), tags, summary: 'Create an SLA policy' }, async (req, res) => {
      sendCreated(res, await ticketService.saveSlaPolicy(req.ctx, null, req.valid.body));
    });
    r.patch('/sla-policies/:policyId', { permission: 'tickets.manage', params: slaParams, body: slaBody, tags, summary: 'Update an SLA policy (applies to new tickets)' }, async (req, res) => {
      sendOk(res, await ticketService.saveSlaPolicy(req.ctx, req.valid.params.policyId, req.valid.body));
    });
  });
}
