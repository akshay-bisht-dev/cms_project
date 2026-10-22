import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendOk } from '../../utils/response.js';
import { ForbiddenError } from '../../utils/errors.js';
import { memberCalendar } from '../attendance/schedule.js';
import { timesheetCsv, timesheetPdf } from './export.js';

const idParams = z.object({ timesheetId: idSchema }).strict();
const listQuery = z
  .object({
    view: z.enum(['mine', 'approvals']).default('mine'),
    status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
    employeeId: idSchema.optional(),
  })
  .strict();
const openBody = z.object({ date: isoDateSchema.optional() }).strict();
const approveBody = z.object({ comment: z.string().trim().max(2000).optional() }).strict();
const rejectBody = z.object({ comment: z.string().trim().min(1, 'Explain what needs to change').max(2000) }).strict();
const exportQuery = z.object({ format: z.enum(['csv', 'pdf']).default('csv') }).strict();

export function timesheetRoutes({ timesheetService, prisma }) {
  const tags = ['Timesheets'];
  return defineRoutes('/timesheets', (r) => {
    r.get('/', { permission: 'timesheets.read', apiKey: true, query: listQuery, tags, summary: 'My timesheets, an employee’s, or my approval queue (view=approvals)' }, async (req, res) => {
      if (req.valid.query.view === 'approvals' && !req.ctx.permissions.has('timesheets.approve')) throw new ForbiddenError();
      sendOk(res, await timesheetService.list(req.ctx, req.valid.query));
    });
    r.post('/', { permission: 'timesheets.submit', body: openBody, tags, summary: 'Open (or refresh) my timesheet for the period containing a date' }, async (req, res) => {
      sendOk(res, await timesheetService.open(req.ctx, req.valid.body));
    });
    r.get('/:timesheetId', { permission: 'timesheets.read', params: idParams, tags, summary: 'Timesheet with entries, history and allowed actions' }, async (req, res) => {
      sendOk(res, await timesheetService.get(req.ctx, req.valid.params.timesheetId));
    });
    r.post('/:timesheetId/submit', { permission: 'timesheets.submit', params: idParams, idempotent: true, tags, summary: 'Submit for approval (locks the entries)' }, async (req, res) => {
      sendOk(res, await timesheetService.submit(req.ctx, req.valid.params.timesheetId));
    });
    r.post('/:timesheetId/approve', { permission: 'timesheets.approve', params: idParams, body: approveBody, idempotent: true, tags, summary: 'Approve a submitted timesheet' }, async (req, res) => {
      sendOk(res, await timesheetService.decide(req.ctx, req.valid.params.timesheetId, { decision: 'APPROVED', ...req.valid.body }));
    });
    r.post('/:timesheetId/reject', { permission: 'timesheets.approve', params: idParams, body: rejectBody, idempotent: true, tags, summary: 'Reject a submitted timesheet (unlocks its entries)' }, async (req, res) => {
      sendOk(res, await timesheetService.decide(req.ctx, req.valid.params.timesheetId, { decision: 'REJECTED', ...req.valid.body }));
    });
    r.post('/:timesheetId/reopen', { permission: 'timesheets.unlock', params: idParams, body: approveBody, tags, summary: 'Reopen an approved timesheet' }, async (req, res) => {
      sendOk(res, await timesheetService.reopen(req.ctx, req.valid.params.timesheetId, req.valid.body));
    });
    r.get('/:timesheetId/export', { permission: 'timesheets.read', params: idParams, query: exportQuery, rateLimit: 'write', tags, summary: 'Download as CSV or PDF' }, async (req, res) => {
      const sheet = await timesheetService.exportData(req.ctx, req.valid.params.timesheetId);
      const owner = await prisma.organizationMember.findFirst({ where: { organizationId: req.ctx.orgId, id: sheet.employee.employeeId } });
      const { zone } = await memberCalendar(prisma, req.ctx.orgId, owner.userId);
      const name = `timesheet-${sheet.periodStart}`;
      if (req.valid.query.format === 'pdf') {
        const pdf = await timesheetPdf(sheet, { organizationName: req.ctx.organization.name, zone });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
        return res.send(pdf);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      res.send(timesheetCsv(sheet, zone));
    });
  });
}
