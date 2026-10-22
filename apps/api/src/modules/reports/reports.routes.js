import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { sendCreated, sendOk } from '../../utils/response.js';
import { REPORT_TYPES } from './definitions.js';

const reportParams = {
  from: isoDateSchema,
  to: isoDateSchema,
  groupBy: z.enum(['member', 'project', 'day', 'stage', 'source', 'client', 'priority', 'month']).optional(),
  employeeId: idSchema.optional(),
  teamId: idSchema.optional(),
  departmentId: idSchema.optional(),
};
const typeParams = z.object({ type: z.enum(REPORT_TYPES) }).strict();
const runQuery = z.object(reportParams).strict();
const jobBody = z.object({ type: z.enum(REPORT_TYPES), format: z.enum(['csv', 'pdf']), params: z.object(reportParams).strict() }).strict();
const jobParams = z.object({ jobId: idSchema }).strict();

export function reportRoutes({ reportService }) {
  const tags = ['Reports'];
  return defineRoutes('/reports', (r) => {
    // The catalog filters itself by permission; holding none simply returns an empty list.
    r.get('/', { permission: MEMBER, tags, summary: 'Reports available to me' }, (req, res) => {
      sendOk(res, reportService.catalog(req.ctx));
    });
    r.get('/jobs', { permission: 'reports.export', tags, summary: 'My report exports' }, async (req, res) => {
      sendOk(res, await reportService.listJobs(req.ctx));
    });
    r.post('/jobs', { permission: 'reports.export', body: jobBody, idempotent: true, rateLimit: 'export', tags, summary: 'Export a report as CSV or PDF (background job, up to 366 days)' }, async (req, res) => {
      sendCreated(res, await reportService.createJob(req.ctx, req.valid.body));
    });
    r.get('/jobs/:jobId', { permission: 'reports.export', params: jobParams, tags, summary: 'Export status' }, async (req, res) => {
      sendOk(res, await reportService.getJob(req.ctx, req.valid.params.jobId));
    });
    r.get('/jobs/:jobId/download', { permission: 'reports.export', params: jobParams, tags, summary: 'Signed 60-second download link (permission re-checked)' }, async (req, res) => {
      sendOk(res, await reportService.download(req.ctx, req.valid.params.jobId));
    });
    // Permission depends on the report type; the service checks the domain permission.
    r.get('/:type', { permission: MEMBER, params: typeParams, query: runQuery, tags, summary: 'Run a report (up to 31 days; data scoped to me)' }, async (req, res) => {
      sendOk(res, await reportService.run(req.ctx, req.valid.params.type, req.valid.query));
    });
  });
}
