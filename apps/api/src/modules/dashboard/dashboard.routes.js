import { idSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendOk } from '../../utils/response.js';

const summaryQuery = z.object({ departmentId: idSchema.optional(), teamId: idSchema.optional() }).strict();

export function dashboardRoutes({ dashboardService }) {
  return defineRoutes('/dashboard', (r) => {
    r.get('/summary', { permission: 'dashboard.read', query: summaryQuery, tags: ['Dashboard'], summary: 'People metrics within my dashboard scope' }, async (req, res) => {
      sendOk(res, await dashboardService.summary(req.ctx, req.valid.query));
    });
  });
}
