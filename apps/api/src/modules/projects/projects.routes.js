import { currencySchema, idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';

const status = z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const money = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Use an amount such as 12500.00');
const fields = {
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'Use up to 32 letters, digits, dashes or underscores'),
  description: z.string().max(20_000).nullable(),
  status,
  priority,
  visibility: z.enum(['PRIVATE', 'ORG']),
  startDate: isoDateSchema.nullable(),
  endDate: isoDateSchema.nullable(),
  deadline: isoDateSchema.nullable(),
  estimatedS: z.number().int().min(0).max(100_000 * 3600).nullable(),
  isBillableDefault: z.boolean(),
  managerEmployeeId: idSchema.nullable(),
  budget: z.object({ amount: money, currency: currencySchema }).strict().nullable(),
  clientId: idSchema.nullable(),
  sharedWithClient: z.boolean(),
};
const createBody = z
  .object({ ...fields, memberEmployeeIds: z.array(idSchema).max(500).default([]) })
  .partial()
  .required({ name: true })
  .strict();
const updateBody = z.object(fields).partial().strict().refine((b) => Object.keys(b).length > 0, 'Provide at least one field');
const listQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.string().regex(/^[A-Z_,]+$/).optional(),
    mine: z.enum(['true', 'false']).optional(),
    includeArchived: z.enum(['true', 'false']).optional(),
    memberEmployeeId: idSchema.optional(),
  })
  .strict();
const idParams = z.object({ projectId: idSchema }).strict();
const statusParams = z.object({ projectId: idSchema, statusId: idSchema }).strict();
const milestoneParams = z.object({ projectId: idSchema, milestoneId: idSchema }).strict();
const membersBody = z
  .object({ members: z.array(z.object({ employeeId: idSchema, role: z.enum(['MANAGER', 'MEMBER', 'VIEWER']) }).strict()).max(500) })
  .strict();
const statusBody = z.object({ name: z.string().trim().min(1).max(60), category: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']) }).strict();
const milestoneBody = z
  .object({ name: z.string().trim().min(1).max(160), dueDate: isoDateSchema.nullable(), completed: z.boolean(), sort: z.number().int() })
  .partial()
  .strict();

export function projectRoutes({ projectService }) {
  const tags = ['Projects'];
  return defineRoutes('/projects', (r) => {
    r.get('/', { permission: 'projects.read', apiKey: true, query: listQuery, tags, summary: 'Projects I can see' }, async (req, res) => {
      sendOk(res, await projectService.list(req.ctx, req.valid.query));
    });
    r.post('/', { permission: 'projects.create', body: createBody, tags, summary: 'Create a project (with default workflow statuses)' }, async (req, res) => {
      sendCreated(res, await projectService.create(req.ctx, req.valid.body));
    });
    r.get('/:projectId', { permission: 'projects.read', apiKey: true, params: idParams, tags, summary: 'Project details and my access' }, async (req, res) => {
      sendOk(res, await projectService.get(req.ctx, req.valid.params.projectId));
    });
    r.patch('/:projectId', { permission: 'projects.manage', params: idParams, body: updateBody, tags, summary: 'Update a project' }, async (req, res) => {
      sendOk(res, await projectService.update(req.ctx, req.valid.params.projectId, req.valid.body));
    });
    r.delete('/:projectId', { permission: 'projects.manage', params: idParams, tags, summary: 'Archive a project' }, async (req, res) => {
      sendOk(res, await projectService.setLifecycle(req.ctx, req.valid.params.projectId, 'archive'));
    });
    r.post('/:projectId/restore', { permission: 'projects.manage', params: idParams, tags, summary: 'Restore an archived project' }, async (req, res) => {
      sendOk(res, await projectService.setLifecycle(req.ctx, req.valid.params.projectId, 'restore'));
    });
    r.post('/:projectId/close', { permission: 'projects.manage', params: idParams, tags, summary: 'Mark a project completed' }, async (req, res) => {
      sendOk(res, await projectService.setLifecycle(req.ctx, req.valid.params.projectId, 'close'));
    });
    r.get('/:projectId/summary', { permission: 'projects.read', params: idParams, tags, summary: 'Task progress, hours budget vs actual, workload' }, async (req, res) => {
      sendOk(res, await projectService.summary(req.ctx, req.valid.params.projectId));
    });

    r.get('/:projectId/members', { permission: 'projects.read', params: idParams, tags, summary: 'Project members and roles' }, async (req, res) => {
      sendOk(res, await projectService.members(req.ctx, req.valid.params.projectId));
    });
    r.put('/:projectId/members', { permission: 'projects.manage', params: idParams, body: membersBody, tags, summary: 'Replace project members' }, async (req, res) => {
      sendOk(res, await projectService.setMembers(req.ctx, req.valid.params.projectId, req.valid.body.members));
    });

    r.get('/:projectId/statuses', { permission: 'projects.read', params: idParams, tags, summary: 'Workflow statuses' }, async (req, res) => {
      sendOk(res, await projectService.statuses(req.ctx, req.valid.params.projectId));
    });
    r.post('/:projectId/statuses', { permission: 'projects.manage', params: idParams, body: statusBody, tags, summary: 'Add a workflow status' }, async (req, res) => {
      sendCreated(res, await projectService.saveStatus(req.ctx, req.valid.params.projectId, null, req.valid.body));
    });
    r.put('/:projectId/statuses/order', { permission: 'projects.manage', params: idParams, body: z.object({ statusIds: z.array(idSchema).min(1).max(30) }).strict(), tags, summary: 'Reorder statuses' }, async (req, res) => {
      sendOk(res, await projectService.reorderStatuses(req.ctx, req.valid.params.projectId, req.valid.body.statusIds));
    });
    r.patch('/:projectId/statuses/:statusId', { permission: 'projects.manage', params: statusParams, body: statusBody, tags, summary: 'Rename or recategorize a status' }, async (req, res) => {
      sendOk(res, await projectService.saveStatus(req.ctx, req.valid.params.projectId, req.valid.params.statusId, req.valid.body));
    });
    r.delete('/:projectId/statuses/:statusId', { permission: 'projects.manage', params: statusParams, body: z.object({ moveToStatusId: idSchema.optional() }).strict().optional(), tags, summary: 'Delete a status (moving its tasks)' }, async (req, res) => {
      sendOk(res, await projectService.deleteStatus(req.ctx, req.valid.params.projectId, req.valid.params.statusId, req.valid.body?.moveToStatusId));
    });

    r.get('/:projectId/milestones', { permission: 'projects.read', params: idParams, tags, summary: 'Milestones with progress' }, async (req, res) => {
      sendOk(res, await projectService.milestones(req.ctx, req.valid.params.projectId));
    });
    r.post('/:projectId/milestones', { permission: 'projects.manage', params: idParams, body: milestoneBody.required({ name: true }), tags, summary: 'Add a milestone' }, async (req, res) => {
      sendCreated(res, await projectService.saveMilestone(req.ctx, req.valid.params.projectId, null, req.valid.body));
    });
    r.patch('/:projectId/milestones/:milestoneId', { permission: 'projects.manage', params: milestoneParams, body: milestoneBody, tags, summary: 'Update a milestone' }, async (req, res) => {
      sendOk(res, await projectService.saveMilestone(req.ctx, req.valid.params.projectId, req.valid.params.milestoneId, req.valid.body));
    });
    r.delete('/:projectId/milestones/:milestoneId', { permission: 'projects.manage', params: milestoneParams, tags, summary: 'Delete a milestone' }, async (req, res) => {
      await projectService.deleteMilestone(req.ctx, req.valid.params.projectId, req.valid.params.milestoneId);
      sendNoContent(res);
    });
  });
}
