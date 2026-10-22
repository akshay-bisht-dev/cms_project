import { MEMBER } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { assignRolesBody, createRoleBody, employeeIdParams, overridesBody, roleIdParams, updateRoleBody } from './roles.schema.js';

export function roleRoutes({ roleService }) {
  const tags = ['Roles & permissions'];
  return defineRoutes('', (r) => {
    r.get('/permissions', { permission: MEMBER, tags, summary: 'Permission catalog' }, (_req, res) => {
      sendOk(res, roleService.listPermissions());
    });
    r.get('/roles', { permission: MEMBER, tags, summary: 'List roles (grants included for role managers)' }, async (req, res) => {
      sendOk(res, await roleService.list(req.ctx));
    });
    r.get('/roles/:roleId', { permission: 'roles.manage', params: roleIdParams, tags, summary: 'Role with its grants' }, async (req, res) => {
      sendOk(res, await roleService.get(req.ctx, req.valid.params.roleId));
    });
    r.post('/roles', { permission: 'roles.manage', body: createRoleBody, tags, summary: 'Create a custom role' }, async (req, res) => {
      sendCreated(res, await roleService.create(req.ctx, req.valid.body));
    });
    r.patch('/roles/:roleId', { permission: 'roles.manage', params: roleIdParams, body: updateRoleBody, tags, summary: 'Update a role' }, async (req, res) => {
      sendOk(res, await roleService.update(req.ctx, req.valid.params.roleId, req.valid.body));
    });
    r.delete('/roles/:roleId', { permission: 'roles.manage', params: roleIdParams, tags, summary: 'Delete an unused custom role' }, async (req, res) => {
      await roleService.remove(req.ctx, req.valid.params.roleId);
      sendNoContent(res);
    });
    r.put(
      '/employees/:employeeId/roles',
      { permission: 'roles.manage', params: employeeIdParams, body: assignRolesBody, tags, summary: "Replace an employee's roles" },
      async (req, res) => {
        sendOk(res, await roleService.setMemberRoles(req.ctx, req.valid.params.employeeId, req.valid.body.roleIds));
      },
    );
    r.put(
      '/employees/:employeeId/permission-overrides',
      { permission: 'roles.manage', params: employeeIdParams, body: overridesBody, tags, summary: "Replace an employee's deny overrides" },
      async (req, res) => {
        sendOk(res, await roleService.setOverrides(req.ctx, req.valid.params.employeeId, req.valid.body));
      },
    );
  });
}
