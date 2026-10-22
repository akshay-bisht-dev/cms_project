import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { ForbiddenError } from '../../utils/errors.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { sendCreated, sendOk } from '../../utils/response.js';

const text = (max) => z.string().trim().min(1).max(max);
const halfDay = z.enum(['FULL', 'AM', 'PM']);
const dayAmount = z.string().regex(/^\d{1,3}(\.(0|00|5|50))?$/, 'Use whole or half days, e.g. 1.5');
const signedDays = z.string().regex(/^-?\d{1,3}(\.(0|00|5|50))?$/, 'Use whole or half days, e.g. -2 or 1.5');
const rule = z.enum(['MANAGER', 'TEAM_LEAD', 'HR']);
const typeBody = z.object({ code: z.string().trim().regex(/^[A-Z0-9_]{2,16}$/, 'Use 2–16 capital letters, digits or _'), name: text(80), isPaid: z.boolean(), allowsHalfDay: z.boolean(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }).partial().strict();
const policyBody = z
  .object({
    leaveTypeId: idSchema,
    name: text(120),
    accrual: z.enum(['NONE', 'MONTHLY', 'ANNUAL']),
    accrualDays: dayAmount,
    capDays: dayAmount.nullable(),
    carryOverMaxDays: dayAmount.nullable(),
    allowNegative: z.boolean(),
    approvalChain: z.array(rule).min(1).max(3),
    isDefault: z.boolean(),
  })
  .partial()
  .strict();
const requestBody = z.object({ leaveTypeId: idSchema, startDate: isoDateSchema, endDate: isoDateSchema, startHalf: halfDay.default('FULL'), endHalf: halfDay.default('FULL'), reason: z.string().trim().max(1000).optional() }).strict();
const list = (schema) => z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(schema));
const listQuery = z
  .object({ view: z.enum(['mine', 'approvals', 'team']).default('mine'), status: list(z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])).optional(), from: isoDateSchema.optional(), to: isoDateSchema.optional(), employeeId: idSchema.optional() })
  .strict();
const balanceQuery = z.object({ employeeId: idSchema.optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }).strict();
const idParams = z.object({ requestId: idSchema }).strict();

export function leaveRoutes({ leaveService }) {
  const tags = ['Leave'];
  return defineRoutes('/leave', (r) => {
    r.get('/types', { permission: MEMBER, tags, summary: 'Leave types' }, async (req, res) => {
      sendOk(res, await leaveService.types(req.ctx));
    });
    r.post('/types', { permission: 'leave.policy.manage', body: typeBody.required({ code: true, name: true }), tags, summary: 'Add a leave type (with a default policy)' }, async (req, res) => {
      sendCreated(res, await leaveService.saveType(req.ctx, null, req.valid.body));
    });
    r.patch('/types/:typeId', { permission: 'leave.policy.manage', params: z.object({ typeId: idSchema }).strict(), body: typeBody.extend({ archived: z.boolean().optional() }), tags, summary: 'Update or archive a leave type' }, async (req, res) => {
      sendOk(res, await leaveService.saveType(req.ctx, req.valid.params.typeId, req.valid.body));
    });
    r.get('/policies', { permission: 'leave.policy.manage', tags, summary: 'Leave policies' }, async (req, res) => {
      sendOk(res, await leaveService.policies(req.ctx));
    });
    r.post('/policies', { permission: 'leave.policy.manage', body: policyBody.required({ leaveTypeId: true, name: true, approvalChain: true }), tags, summary: 'Add a leave policy' }, async (req, res) => {
      sendCreated(res, await leaveService.savePolicy(req.ctx, null, req.valid.body));
    });
    r.patch('/policies/:policyId', { permission: 'leave.policy.manage', params: z.object({ policyId: idSchema }).strict(), body: policyBody.omit({ leaveTypeId: true }), tags, summary: 'Update a leave policy' }, async (req, res) => {
      sendOk(res, await leaveService.savePolicy(req.ctx, req.valid.params.policyId, req.valid.body));
    });
    r.put('/policies/:policyId/assignments', { permission: 'leave.policy.manage', params: z.object({ policyId: idSchema }).strict(), body: z.object({ targets: z.array(z.object({ type: z.enum(['DEPARTMENT', 'TEAM', 'MEMBER']), id: idSchema }).strict()).max(500) }).strict(), tags, summary: 'Who a policy applies to (member > team > department > default)' }, async (req, res) => {
      sendOk(res, await leaveService.assignPolicy(req.ctx, req.valid.params.policyId, req.valid.body.targets));
    });

    r.get('/balances', { permission: 'leave.self', query: balanceQuery, tags, summary: 'Balances per leave type (mine, or someone in my leave.read scope)' }, async (req, res) => {
      sendOk(res, await leaveService.balances(req.ctx, req.valid.query));
    });
    r.get('/ledger', { permission: 'leave.self', query: balanceQuery.extend({ leaveTypeId: idSchema }), tags, summary: 'Ledger entries behind a balance' }, async (req, res) => {
      sendOk(res, await leaveService.ledger(req.ctx, req.valid.query));
    });
    r.post('/balances/adjust', { permission: 'leave.balance.adjust', body: z.object({ employeeId: idSchema, leaveTypeId: idSchema, days: signedDays, effectiveDate: isoDateSchema.optional(), note: text(500) }).strict(), idempotent: true, tags, summary: 'Adjust a balance (ledger entry, audited)' }, async (req, res) => {
      sendCreated(res, await leaveService.adjust(req.ctx, req.valid.body));
    });

    r.post('/requests/preview', { permission: 'leave.self', body: requestBody.omit({ reason: true }), tags, summary: 'Working days a request would use and the balance after it' }, async (req, res) => {
      sendOk(res, await leaveService.preview(req.ctx, req.valid.body));
    });
    r.get('/requests', { permission: 'leave.self', query: listQuery, tags, summary: 'My requests, those awaiting my approval, or my team’s' }, async (req, res) => {
      if (req.valid.query.view === 'approvals' && !hasPermission(req.ctx, 'leave.approve')) throw new ForbiddenError();
      if (req.valid.query.view === 'team' && !hasPermission(req.ctx, 'leave.read')) throw new ForbiddenError();
      sendOk(res, await leaveService.list(req.ctx, req.valid.query));
    });
    r.post('/requests', { permission: 'leave.self', body: requestBody, idempotent: true, tags, summary: 'Request leave (overlap and balance checked)' }, async (req, res) => {
      sendCreated(res, await leaveService.request(req.ctx, req.valid.body));
    });
    r.get('/requests/:requestId', { permission: MEMBER, params: idParams, tags, summary: 'A leave request with its approval history' }, async (req, res) => {
      sendOk(res, await leaveService.get(req.ctx, req.valid.params.requestId));
    });
    r.post('/requests/:requestId/approve', { permission: 'leave.approve', params: idParams, body: z.object({ comment: text(1000).optional() }).strict(), idempotent: true, tags, summary: 'Approve the current step' }, async (req, res) => {
      sendOk(res, await leaveService.decide(req.ctx, req.valid.params.requestId, { decision: 'APPROVE', comment: req.valid.body.comment }));
    });
    r.post('/requests/:requestId/reject', { permission: 'leave.approve', params: idParams, body: z.object({ comment: text(1000) }).strict(), idempotent: true, tags, summary: 'Reject (comment required)' }, async (req, res) => {
      sendOk(res, await leaveService.decide(req.ctx, req.valid.params.requestId, { decision: 'REJECT', comment: req.valid.body.comment }));
    });
    r.post('/requests/:requestId/cancel', { permission: MEMBER, params: idParams, body: z.object({ comment: text(1000).optional() }).strict(), idempotent: true, tags, summary: 'Cancel (approved leave returns to the balance)' }, async (req, res) => {
      sendOk(res, await leaveService.cancel(req.ctx, req.valid.params.requestId, req.valid.body));
    });
    r.get('/calendar', { permission: 'leave.read', query: z.object({ from: isoDateSchema, to: isoDateSchema }).strict(), tags, summary: 'Leave of everyone in my scope' }, async (req, res) => {
      sendOk(res, await leaveService.calendar(req.ctx, req.valid.query));
    });
  });
}
