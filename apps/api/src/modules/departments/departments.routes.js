import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { createDepartmentBody, departmentIdParams, listDepartmentsQuery, updateDepartmentBody } from './departments.schema.js';

export function departmentRoutes({ departmentService }) {
  const tags = ['Departments'];
  return defineRoutes('/departments', (r) => {
    r.get('/', { permission: 'employees.read', apiKey: true, query: listDepartmentsQuery, tags, summary: 'List departments' }, async (req, res) => {
      sendOk(res, await departmentService.list(req.ctx, req.valid.query));
    });
    r.get('/:departmentId', { permission: 'employees.read', params: departmentIdParams, tags, summary: 'Get a department' }, async (req, res) => {
      sendOk(res, await departmentService.get(req.ctx, req.valid.params.departmentId));
    });
    r.post('/', { permission: 'departments.manage', body: createDepartmentBody, tags, summary: 'Create a department' }, async (req, res) => {
      sendCreated(res, await departmentService.create(req.ctx, req.valid.body));
    });
    r.patch('/:departmentId', { permission: 'departments.manage', params: departmentIdParams, body: updateDepartmentBody, tags, summary: 'Update a department' }, async (req, res) => {
      sendOk(res, await departmentService.update(req.ctx, req.valid.params.departmentId, req.valid.body));
    });
    r.delete('/:departmentId', { permission: 'departments.manage', params: departmentIdParams, tags, summary: 'Archive a department' }, async (req, res) => {
      await departmentService.archive(req.ctx, req.valid.params.departmentId);
      sendNoContent(res);
    });
  });
}
