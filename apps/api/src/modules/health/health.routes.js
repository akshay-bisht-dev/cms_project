import { PUBLIC } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendOk } from '../../utils/response.js';
import { UnavailableError } from '../../utils/errors.js';

export function healthRoutes({ healthService }) {
  return defineRoutes('/health', (r) => {
    r.get('/live', { permission: PUBLIC, summary: 'Process liveness' }, (_req, res) => {
      sendOk(res, { status: 'live', uptimeSeconds: Math.round(process.uptime()) });
    });

    r.get('/ready', { permission: PUBLIC, summary: 'Dependency readiness' }, async (req, res) => {
      const report = await healthService.readiness();
      if (report.status !== 'ready') {
        req.log?.warn({ checks: report.checks }, 'readiness check failed');
        // Error details stay in logs; clients only learn which dependency is down.
        const details = Object.entries(report.checks)
          .filter(([, c]) => c.status !== 'up')
          .map(([name]) => ({ path: name, message: 'unavailable' }));
        throw new UnavailableError('One or more dependencies are unavailable', details);
      }
      sendOk(res, report);
    });
  });
}
