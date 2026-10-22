import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { createTeamBody, listTeamsQuery, setTeamMembersBody, teamIdParams, updateTeamBody } from './teams.schema.js';

export function teamRoutes({ teamService }) {
  const tags = ['Teams'];
  return defineRoutes('/teams', (r) => {
    r.get('/', { permission: 'employees.read', apiKey: true, query: listTeamsQuery, tags, summary: 'List teams' }, async (req, res) => {
      sendOk(res, await teamService.list(req.ctx, req.valid.query));
    });
    r.get('/:teamId', { permission: 'employees.read', params: teamIdParams, tags, summary: 'Get a team with its members' }, async (req, res) => {
      sendOk(res, await teamService.get(req.ctx, req.valid.params.teamId));
    });
    r.post('/', { permission: 'teams.manage', body: createTeamBody, tags, summary: 'Create a team' }, async (req, res) => {
      sendCreated(res, await teamService.create(req.ctx, req.valid.body));
    });
    r.patch('/:teamId', { permission: 'teams.manage', params: teamIdParams, body: updateTeamBody, tags, summary: 'Update a team' }, async (req, res) => {
      sendOk(res, await teamService.update(req.ctx, req.valid.params.teamId, req.valid.body));
    });
    r.put('/:teamId/members', { permission: 'teams.manage', params: teamIdParams, body: setTeamMembersBody, tags, summary: 'Replace team members' }, async (req, res) => {
      sendOk(res, await teamService.setMembers(req.ctx, req.valid.params.teamId, req.valid.body.employeeIds));
    });
    r.delete('/:teamId', { permission: 'teams.manage', params: teamIdParams, tags, summary: 'Archive a team' }, async (req, res) => {
      await teamService.archive(req.ctx, req.valid.params.teamId);
      sendNoContent(res);
    });
  });
}
