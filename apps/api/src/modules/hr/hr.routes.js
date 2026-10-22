import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { DOCUMENT_TYPES } from './hr.service.js';

const text = (max) => z.string().trim().min(1).max(max);
const emp = z.object({ employeeId: idSchema }).strict();
const docParams = z.object({ employeeId: idSchema, documentId: idSchema }).strict();
const item = z.object({ title: text(200), assignee: z.enum(['HR', 'MANAGER', 'EMPLOYEE']), dueOffsetDays: z.number().int().min(0).max(365).default(0) }).strict();
const templateBody = z.object({ kind: z.enum(['ONBOARDING', 'OFFBOARDING']), name: text(120), items: z.array(item).min(1).max(50), isDefault: z.boolean() }).partial().strict();

export function hrRoutes({ hrService }) {
  const tags = ['HR'];
  return defineRoutes('', (r) => {
    r.get('/employees/:employeeId/documents', { permission: 'documents.hr.read', params: emp, tags, summary: 'Employment documents (HR: all; employee: those shared with them)' }, async (req, res) => {
      sendOk(res, await hrService.documents(req.ctx, req.valid.params.employeeId));
    });
    r.post('/employees/:employeeId/documents/uploads', { permission: 'documents.hr.manage', params: emp, body: z.object({ fileName: text(255), contentType: z.string().max(127), sizeBytes: z.number().int().min(1) }).strict(), tags, summary: 'Signed upload for a document' }, async (req, res) => {
      sendCreated(res, await hrService.presignDocument(req.ctx, req.valid.params.employeeId, req.valid.body));
    });
    r.post('/employees/:employeeId/documents', { permission: 'documents.hr.manage', params: emp, body: z.object({ fileId: idSchema, type: z.enum(DOCUMENT_TYPES), title: text(200), visibility: z.enum(['HR_ONLY', 'EMPLOYEE']).default('HR_ONLY'), expiresOn: isoDateSchema.optional() }).strict(), tags, summary: 'Attach an uploaded document' }, async (req, res) => {
      sendCreated(res, await hrService.addDocument(req.ctx, req.valid.params.employeeId, req.valid.body));
    });
    r.get('/employees/:employeeId/documents/:documentId/download', { permission: 'documents.hr.read', params: docParams, tags, summary: 'Signed 60-second link (audited)' }, async (req, res) => {
      sendOk(res, await hrService.documentUrl(req.ctx, req.valid.params.employeeId, req.valid.params.documentId));
    });
    r.delete('/employees/:employeeId/documents/:documentId', { permission: 'documents.hr.manage', params: docParams, tags, summary: 'Archive a document' }, async (req, res) => {
      await hrService.archiveDocument(req.ctx, req.valid.params.employeeId, req.valid.params.documentId);
      sendNoContent(res);
    });
    r.get('/hr/documents/expiring', { permission: 'documents.hr.manage', query: z.object({ days: z.coerce.number().int().min(0).max(365).default(30) }).strict(), tags, summary: 'Documents expiring within N days (or expired)' }, async (req, res) => {
      sendOk(res, await hrService.expiringDocuments(req.ctx, req.valid.query));
    });

    r.get('/checklist-templates', { permission: 'employees.create', tags, summary: 'Onboarding and offboarding templates' }, async (req, res) => sendOk(res, await hrService.templates(req.ctx)));
    r.post('/checklist-templates', { permission: 'employees.create', body: templateBody.required({ kind: true, name: true, items: true }), tags, summary: 'Add a template' }, async (req, res) => {
      sendCreated(res, await hrService.saveTemplate(req.ctx, null, req.valid.body));
    });
    r.patch('/checklist-templates/:templateId', { permission: 'employees.create', params: z.object({ templateId: idSchema }).strict(), body: templateBody.omit({ kind: true }).extend({ archived: z.boolean().optional() }), tags, summary: 'Update a template' }, async (req, res) => {
      sendOk(res, await hrService.saveTemplate(req.ctx, req.valid.params.templateId, req.valid.body));
    });
    r.get('/employees/:employeeId/checklists', { permission: MEMBER, params: emp, tags, summary: 'Onboarding/offboarding checklists of an employee' }, async (req, res) => {
      sendOk(res, await hrService.checklists(req.ctx, req.valid.params.employeeId));
    });
    r.post('/employees/:employeeId/checklists', { permission: 'employees.create', params: emp, body: z.object({ kind: z.enum(['ONBOARDING', 'OFFBOARDING']), templateId: idSchema.optional() }).strict(), tags, summary: 'Start a checklist' }, async (req, res) => {
      sendCreated(res, await hrService.start(req.ctx, req.valid.params.employeeId, req.valid.body));
    });
    r.get('/checklist-tasks', { permission: MEMBER, tags, summary: 'My open checklist tasks (HR also sees the HR pool)' }, async (req, res) => sendOk(res, await hrService.myTasks(req.ctx)));
    r.post('/checklist-tasks/:taskId/done', { permission: MEMBER, params: z.object({ taskId: idSchema }).strict(), body: z.object({ done: z.boolean() }).strict(), tags, summary: 'Mark a task done (or not)' }, async (req, res) => {
      sendOk(res, await hrService.completeTask(req.ctx, req.valid.params.taskId, req.valid.body.done));
    });
  });
}
