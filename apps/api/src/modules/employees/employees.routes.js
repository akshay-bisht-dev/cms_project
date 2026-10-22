import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import {
  bulkInviteBody,
  createEmployeeBody,
  employeeIdParams,
  exportEmployeesQuery,
  historyQuery,
  listEmployeesQuery,
  offboardBody,
  updateEmployeeBody,
} from './employees.schema.js';

export function employeeRoutes({ employeeService }) {
  const tags = ['Employees'];
  return defineRoutes('/employees', (r) => {
    r.get('/', { permission: 'employees.read', apiKey: true, query: listEmployeesQuery, tags, summary: 'Employee directory (cursor-paginated)' }, async (req, res) => {
      const { items, nextCursor } = await employeeService.list(req.ctx, req.valid.query);
      sendOk(res, items, { meta: { page: { nextCursor, limit: req.valid.query.limit } } });
    });

    r.get('/export', { permission: 'employees.export', query: exportEmployeesQuery, rateLimit: 'write', tags, summary: 'Export the directory as CSV' }, async (req, res) => {
      const csv = await employeeService.exportCsv(req.ctx, req.valid.query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    });

    r.post('/', { permission: 'employees.create', body: createEmployeeBody, idempotent: true, tags, summary: 'Add an employee and send an invitation' }, async (req, res) => {
      const { sendInvitation, ...input } = req.valid.body;
      sendCreated(res, await employeeService.create(req.ctx, input, { send: sendInvitation }));
    });

    r.post('/invitations', { permission: 'invitations.manage', body: bulkInviteBody, idempotent: true, tags, summary: 'Invite up to 50 employees' }, async (req, res) => {
      const results = [];
      for (const [index, input] of req.valid.body.invitations.entries()) {
        try {
          results.push({ index, ok: true, ...(await employeeService.create(req.ctx, { teamIds: [], ...input })) });
        } catch (err) {
          if (!err.expose) throw err;
          results.push({ index, ok: false, error: { code: err.code, message: err.message, details: err.details ?? [] } });
        }
      }
      sendOk(res, results, { status: results.some((r) => r.ok) ? 201 : 422 });
    });

    r.get('/:employeeId', { permission: 'employees.read', apiKey: true, params: employeeIdParams, tags, summary: 'Employee profile (field groups filtered by permission)' }, async (req, res) => {
      sendOk(res, await employeeService.get(req.ctx, req.valid.params.employeeId));
    });

    // Field-group permissions are enforced in the service; MEMBER-level access is enough to try.
    r.patch('/:employeeId', { permission: 'employees.read', params: employeeIdParams, body: updateEmployeeBody, tags, summary: 'Update profile fields' }, async (req, res) => {
      sendOk(res, await employeeService.update(req.ctx, req.valid.params.employeeId, req.valid.body));
    });

    r.get('/:employeeId/history', { permission: 'employees.history.read', params: employeeIdParams, query: historyQuery, tags, summary: 'Profile change history' }, async (req, res) => {
      const { items, nextCursor } = await employeeService.history(req.ctx, req.valid.params.employeeId, req.valid.query);
      sendOk(res, items, { meta: { page: { nextCursor, limit: req.valid.query.limit } } });
    });

    r.post('/:employeeId/activate', { permission: 'employees.deactivate', params: employeeIdParams, tags, summary: 'Reactivate an employee' }, async (req, res) => {
      sendOk(res, await employeeService.activate(req.ctx, req.valid.params.employeeId));
    });

    r.post('/:employeeId/deactivate', { permission: 'employees.deactivate', params: employeeIdParams, tags, summary: 'Deactivate an employee (signs them out)' }, async (req, res) => {
      sendOk(res, await employeeService.deactivate(req.ctx, req.valid.params.employeeId));
    });

    r.post('/:employeeId/offboard', { permission: 'employees.deactivate', params: employeeIdParams, body: offboardBody, idempotent: true, tags, summary: 'Offboard an employee' }, async (req, res) => {
      sendOk(res, await employeeService.offboard(req.ctx, req.valid.params.employeeId, req.valid.body));
    });

    r.delete('/:employeeId', { permission: 'employees.deactivate', params: employeeIdParams, tags, summary: 'Archive a deactivated or invited employee' }, async (req, res) => {
      await employeeService.archive(req.ctx, req.valid.params.employeeId);
      sendNoContent(res);
    });
  });
}
