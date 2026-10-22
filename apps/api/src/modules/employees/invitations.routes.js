import { defineRoutes } from '../../routes/define-routes.js';
import { sendNoContent, sendOk } from '../../utils/response.js';
import { invitationIdParams } from './employees.schema.js';

export function invitationRoutes({ employeeService }) {
  const tags = ['Employees'];
  return defineRoutes('/invitations', (r) => {
    r.get('/', { permission: 'invitations.manage', tags, summary: 'Pending invitations' }, async (req, res) => {
      sendOk(res, await employeeService.listInvitations(req.ctx));
    });
    r.post('/:invitationId/resend', { permission: 'invitations.manage', params: invitationIdParams, tags, summary: 'Resend an invitation with a new link' }, async (req, res) => {
      sendOk(res, await employeeService.resendInvitation(req.ctx, req.valid.params.invitationId));
    });
    r.delete('/:invitationId', { permission: 'invitations.manage', params: invitationIdParams, tags, summary: 'Revoke an invitation' }, async (req, res) => {
      await employeeService.revokeInvitation(req.ctx, req.valid.params.invitationId);
      sendNoContent(res);
    });
  });
}
