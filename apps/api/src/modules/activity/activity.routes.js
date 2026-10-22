import { idSchema, isoDateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendOk } from '../../utils/response.js';

const dayQuery = z.object({ employeeId: idSchema.optional(), date: isoDateSchema }).strict();
const weekQuery = z.object({ employeeId: idSchema.optional(), weekStart: isoDateSchema }).strict();
const teamQuery = z.object({ date: isoDateSchema, teamId: idSchema.optional(), departmentId: idSchema.optional() }).strict();
const trendsQuery = z.object({ weeks: z.coerce.number().int().min(2).max(26).default(8), teamId: idSchema.optional(), departmentId: idSchema.optional() }).strict();

export function activityRoutes({ activityService }) {
  const tags = ['Activity & insights'];
  return defineRoutes('/activity', (r) => {
    r.get('/day', { permission: 'reports.attendance.read', query: dayQuery, tags, summary: 'One person’s day: totals, events and intervals' }, async (req, res) => {
      sendOk(res, await activityService.day(req.ctx, req.valid.query));
    });
    r.get('/week', { permission: 'reports.attendance.read', query: weekQuery, tags, summary: 'One person’s week by day, with project split' }, async (req, res) => {
      sendOk(res, await activityService.week(req.ctx, req.valid.query));
    });
    r.get('/team', { permission: 'reports.attendance.read', query: teamQuery, tags, summary: 'Everyone in scope for one day' }, async (req, res) => {
      sendOk(res, await activityService.team(req.ctx, req.valid.query));
    });
    r.get('/trends', { permission: 'reports.attendance.read', query: trendsQuery, tags, summary: 'Weekly trends for everyone in scope' }, async (req, res) => {
      sendOk(res, await activityService.trends(req.ctx, req.valid.query));
    });
  });
}
