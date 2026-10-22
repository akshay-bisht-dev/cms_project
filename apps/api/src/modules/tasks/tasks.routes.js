import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { MEMBER } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';

const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const recurrence = z
  .object({ frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']), interval: z.number().int().min(1).max(52).default(1) })
  .strict()
  .nullable();
const editable = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50_000).nullable(),
  statusId: idSchema,
  priority,
  startDate: isoDateSchema.nullable(),
  dueDate: isoDateSchema.nullable(),
  estimatedS: z.number().int().min(0).max(10_000 * 3600).nullable(),
  milestoneId: idSchema.nullable(),
  recurrence,
};
const createBody = z
  .object({
    projectId: idSchema,
    parentId: idSchema.optional(),
    assigneeEmployeeIds: z.array(idSchema).max(20).default([]),
    labelIds: z.array(idSchema).max(20).default([]),
    ...Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])),
  })
  .strict()
  .refine((b) => b.title, { path: ['title'], message: 'Enter a title' })
  .refine((b) => !b.startDate || !b.dueDate || b.startDate <= b.dueDate, { path: ['dueDate'], message: 'Due date must be on or after the start date' });
const updateBody = z
  .object({ ...editable, sort: z.number().finite(), version: z.number().int().min(0) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field');
const listQuery = z
  .object({
    projectId: idSchema.optional(),
    assignee: z.union([z.literal('me'), idSchema]).optional(),
    statusCategory: z.string().regex(/^[A-Z_,]+$/).optional(),
    statusId: idSchema.optional(),
    milestoneId: idSchema.optional(),
    labelId: idSchema.optional(),
    parentId: z.union([z.literal('none'), idSchema]).optional(),
    q: z.string().trim().max(100).optional(),
    dueFrom: isoDateSchema.optional(),
    dueTo: isoDateSchema.optional(),
    sort: z.enum(['board', 'dueDate', 'priority', '-createdAt']).default('board'),
    includeArchived: z.enum(['true', 'false']).optional(),
  })
  .strict();
const idParams = z.object({ taskId: idSchema }).strict();
const itemParams = z.object({ taskId: idSchema, itemId: idSchema }).strict();
const commentParams = z.object({ taskId: idSchema, commentId: idSchema }).strict();
const depParams = z.object({ taskId: idSchema, dependsOnTaskId: idSchema }).strict();
const fileParams = z.object({ taskId: idSchema, fileId: idSchema }).strict();
const bulkBody = z
  .object({
    taskIds: z.array(idSchema).min(1).max(200),
    action: z.enum(['status', 'priority', 'assign', 'archive']),
    value: z.string().max(36).optional(),
  })
  .strict()
  .refine((b) => b.action === 'archive' || b.value, { path: ['value'], message: 'Provide a value' })
  .refine((b) => b.action !== 'priority' || priority.safeParse(b.value).success, { path: ['value'], message: 'Unknown priority' });
const presignBody = z
  .object({ fileName: z.string().trim().min(1).max(255), contentType: z.string().max(127), sizeBytes: z.number().int().min(1) })
  .strict();

export function taskRoutes({ taskService }) {
  const tags = ['Tasks'];
  return defineRoutes('', (r) => {
    r.get('/tasks', { permission: MEMBER, apiKey: true, query: listQuery, tags, summary: 'Tasks in a project, or mine across projects (assignee=me)' }, async (req, res) => {
      const { items, truncated } = await taskService.list(req.ctx, req.valid.query);
      sendOk(res, items, { meta: { truncated } });
    });
    r.post('/tasks', { permission: 'tasks.create', body: createBody, idempotent: true, tags, summary: 'Create a task' }, async (req, res) => {
      sendCreated(res, await taskService.create(req.ctx, req.valid.body));
    });
    r.post('/tasks/bulk', { permission: 'tasks.update', body: bulkBody, tags, summary: 'Change status, priority, assignee, or archive many tasks' }, async (req, res) => {
      sendOk(res, await taskService.bulk(req.ctx, req.valid.body));
    });
    r.get('/tasks/:taskId', { permission: MEMBER, apiKey: true, params: idParams, tags, summary: 'Task with checklist, comments, attachments, dependencies and history' }, async (req, res) => {
      sendOk(res, await taskService.get(req.ctx, req.valid.params.taskId));
    });
    r.patch('/tasks/:taskId', { permission: 'tasks.update', params: idParams, body: updateBody, tags, summary: 'Update a task (status, dates, board position…)' }, async (req, res) => {
      sendOk(res, await taskService.update(req.ctx, req.valid.params.taskId, req.valid.body));
    });
    r.delete('/tasks/:taskId', { permission: 'tasks.update', params: idParams, tags, summary: 'Archive a task and its subtasks' }, async (req, res) => {
      await taskService.archive(req.ctx, req.valid.params.taskId);
      sendNoContent(res);
    });
    r.post('/tasks/:taskId/restore', { permission: 'tasks.update', params: idParams, tags, summary: 'Restore an archived task' }, async (req, res) => {
      sendOk(res, await taskService.restore(req.ctx, req.valid.params.taskId));
    });
    r.put('/tasks/:taskId/assignees', { permission: 'tasks.update', params: idParams, body: z.object({ employeeIds: z.array(idSchema).max(20) }).strict(), tags, summary: 'Replace assignees' }, async (req, res) => {
      sendOk(res, await taskService.setAssignees(req.ctx, req.valid.params.taskId, req.valid.body.employeeIds));
    });
    r.put('/tasks/:taskId/labels', { permission: 'tasks.update', params: idParams, body: z.object({ labelIds: z.array(idSchema).max(20) }).strict(), tags, summary: 'Replace labels' }, async (req, res) => {
      sendOk(res, await taskService.setLabels(req.ctx, req.valid.params.taskId, req.valid.body.labelIds));
    });
    r.post('/tasks/:taskId/checklist', { permission: 'tasks.update', params: idParams, body: z.object({ text: z.string().trim().min(1).max(300) }).strict(), tags, summary: 'Add a checklist item' }, async (req, res) => {
      sendCreated(res, await taskService.addChecklistItem(req.ctx, req.valid.params.taskId, req.valid.body));
    });
    r.patch('/tasks/:taskId/checklist/:itemId', { permission: 'tasks.update', params: itemParams, body: z.object({ text: z.string().trim().min(1).max(300), done: z.boolean() }).partial().strict(), tags, summary: 'Edit or tick a checklist item' }, async (req, res) => {
      sendOk(res, await taskService.updateChecklistItem(req.ctx, req.valid.params.taskId, req.valid.params.itemId, req.valid.body));
    });
    r.delete('/tasks/:taskId/checklist/:itemId', { permission: 'tasks.update', params: itemParams, tags, summary: 'Remove a checklist item' }, async (req, res) => {
      sendOk(res, await taskService.deleteChecklistItem(req.ctx, req.valid.params.taskId, req.valid.params.itemId));
    });
    r.post('/tasks/:taskId/comments', { permission: MEMBER, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }).strict(), tags, summary: 'Comment on a task (notifies assignees)' }, async (req, res) => {
      sendCreated(res, await taskService.addComment(req.ctx, req.valid.params.taskId, req.valid.body));
    });
    r.patch('/tasks/:taskId/comments/:commentId', { permission: MEMBER, params: commentParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }).strict(), tags, summary: 'Edit my comment' }, async (req, res) => {
      sendOk(res, await taskService.editComment(req.ctx, req.valid.params.taskId, req.valid.params.commentId, req.valid.body));
    });
    r.delete('/tasks/:taskId/comments/:commentId', { permission: MEMBER, params: commentParams, tags, summary: 'Delete my comment (project managers: any)' }, async (req, res) => {
      sendOk(res, await taskService.deleteComment(req.ctx, req.valid.params.taskId, req.valid.params.commentId));
    });
    r.post('/tasks/:taskId/dependencies', { permission: 'tasks.update', params: idParams, body: z.object({ dependsOnTaskId: idSchema }).strict(), tags, summary: 'Make this task wait for another (cycles rejected)' }, async (req, res) => {
      sendOk(res, await taskService.addDependency(req.ctx, req.valid.params.taskId, req.valid.body.dependsOnTaskId));
    });
    r.delete('/tasks/:taskId/dependencies/:dependsOnTaskId', { permission: 'tasks.update', params: depParams, tags, summary: 'Remove a dependency' }, async (req, res) => {
      sendOk(res, await taskService.removeDependency(req.ctx, req.valid.params.taskId, req.valid.params.dependsOnTaskId));
    });
    r.post('/tasks/:taskId/attachments/presign', { permission: 'tasks.update', params: idParams, body: presignBody, tags, summary: 'Get a signed URL to upload an attachment' }, async (req, res) => {
      sendCreated(res, await taskService.presignAttachment(req.ctx, req.valid.params.taskId, req.valid.body));
    });
    r.post('/tasks/:taskId/attachments/:fileId/complete', { permission: 'tasks.update', params: fileParams, tags, summary: 'Verify an upload and attach it' }, async (req, res) => {
      sendOk(res, await taskService.completeAttachment(req.ctx, req.valid.params.taskId, req.valid.params.fileId));
    });
    r.get('/tasks/:taskId/attachments/:fileId/access-url', { permission: MEMBER, params: fileParams, tags, summary: 'Short-lived download link (60 s)' }, async (req, res) => {
      sendOk(res, await taskService.attachmentUrl(req.ctx, req.valid.params.taskId, req.valid.params.fileId));
    });
    r.delete('/tasks/:taskId/attachments/:fileId', { permission: 'tasks.update', params: fileParams, tags, summary: 'Remove an attachment' }, async (req, res) => {
      sendOk(res, await taskService.removeAttachment(req.ctx, req.valid.params.taskId, req.valid.params.fileId));
    });

    r.get('/labels', { permission: MEMBER, tags, summary: 'Task labels' }, async (req, res) => {
      sendOk(res, await taskService.listLabels(req.ctx));
    });
    r.post('/labels', { permission: 'tasks.update', body: z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6D4AE0') }).strict(), tags, summary: 'Create a label' }, async (req, res) => {
      sendCreated(res, await taskService.createLabel(req.ctx, req.valid.body));
    });
  });
}
