import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { pinoHttp } from 'pino-http';
import { API_PREFIX } from '@orbit/shared-constants';
import { requestId } from './middleware/request-id.js';
import { requestTimeout } from './middleware/timeout.js';
import { sessionContext } from './middleware/session.js';
import { csrfProtection } from './middleware/csrf.js';
import { idempotency } from './middleware/idempotency.js';
import { rateLimit } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { buildApiRouter } from './routes/index.js';
import { listRoutes } from './routes/define-routes.js';
import { systemClock } from './services/clock.js';
import { createFieldCipher } from './services/crypto.js';
import { createMemoryRateLimitStore } from './services/rate-limiter.js';
import { createCursorCodec } from './utils/cursor.js';
import { createHealthService } from './modules/health/health.service.js';
import { createSessionService } from './modules/auth/session.service.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createOrganizationService } from './modules/organizations/organizations.service.js';
import { createRoleService } from './modules/roles/roles.service.js';
import { createDepartmentService } from './modules/departments/departments.service.js';
import { createTeamService } from './modules/teams/teams.service.js';
import { createEmployeeService } from './modules/employees/employees.service.js';
import { buildOpenApiDocument } from './modules/docs/openapi.js';
import { createNotificationService } from './modules/notifications/notifications.service.js';
import { createDashboardService } from './modules/dashboard/dashboard.service.js';
import { nullRealtime } from './sockets/realtime.js';
import { createWorkService } from './modules/attendance/work.service.js';
import { createAttendanceService } from './modules/attendance/attendance.service.js';
import { createTimeEntryService } from './modules/time-tracking/time-entries.service.js';
import { createTimesheetService } from './modules/timesheets/timesheets.service.js';
import { createFileService } from './modules/files/files.service.js';
import { createProjectService } from './modules/projects/projects.service.js';
import { createTaskService } from './modules/tasks/tasks.service.js';
import { createCalendarService } from './modules/calendar/calendar.service.js';
import { createMonitoringService } from './modules/monitoring/monitoring.service.js';
import { agentContext } from './modules/monitoring/agent-context.js';
import { apiKeyContext } from './modules/integrations/api-keys.js';
import { httpMetricsMiddleware } from './services/metrics.js';
import { createActivityService } from './modules/activity/activity.service.js';
import { createReportService } from './modules/reports/reports.service.js';
import { createCrmService } from './modules/crm/crm.service.js';
import { createSalesService } from './modules/crm/sales.service.js';
import { createTicketService } from './modules/tickets/tickets.service.js';
import { createRateService } from './modules/finance/rates.service.js';
import { createExpenseService } from './modules/finance/expenses.service.js';
import { createInvoiceService } from './modules/finance/invoices.service.js';
import { createPortalService } from './modules/portal/portal.service.js';
import { createLeaveService } from './modules/leave/leave.service.js';
import { createWebhookService } from './modules/integrations/webhooks.service.js';
import { createApiKeyService } from './modules/integrations/api-keys.js';
import { createAuditService } from './modules/integrations/audit.service.js';
import { createCustomFieldService } from './modules/custom-fields/custom-fields.service.js';
import { createHrService } from './modules/hr/hr.service.js';

/** Wires services from infrastructure. Exported so the worker and scripts share one composition. */
export function createServices({ env, prisma, redis, storage, clock = systemClock }) {
  const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
  const cursorCodec = createCursorCodec(env.SESSION_SECRET);
  const sessionService = createSessionService({ prisma, env, clock });
  const authService = createAuthService({ prisma, env, clock, cipher, sessionService });
  const fileService = createFileService({ prisma, storage });
  const taskService = createTaskService({ prisma, clock, cipher, env, fileService });
  const ticketService = createTicketService({ prisma, clock, cipher, env });
  return {
    cipher,
    cursorCodec,
    sessionService,
    authService,
    healthService: createHealthService({ prisma, redis, storage, clock: () => clock.now() }),
    organizationService: createOrganizationService({ prisma, authService }),
    roleService: createRoleService({ prisma, cipher, env }),
    notificationService: createNotificationService({ prisma, clock, cursorCodec }),
    dashboardService: createDashboardService({ prisma, clock }),
    workService: createWorkService({ prisma, clock, taskService }),
    fileService,
    taskService,
    projectService: createProjectService({ prisma, clock }),
    calendarService: createCalendarService({ prisma, clock, cipher, env }),
    monitoringService: createMonitoringService({ prisma, clock, env, storage, cipher }),
    activityService: createActivityService({ prisma, clock }),
    reportService: createReportService({ prisma, clock, storage }),
    crmService: createCrmService({ prisma, clock, cipher, env }),
    salesService: createSalesService({ prisma, clock }),
    ticketService,
    rateService: createRateService({ prisma, clock }),
    expenseService: createExpenseService({ prisma, clock, cipher, env, fileService }),
    invoiceService: createInvoiceService({ prisma, clock }),
    portalService: createPortalService({ prisma, clock, ticketService }),
    leaveService: createLeaveService({ prisma, clock, cipher, env }),
    webhookService: createWebhookService({ prisma, clock, cipher, env }),
    apiKeyService: createApiKeyService({ prisma, clock }),
    auditService: createAuditService({ prisma }),
    customFieldService: createCustomFieldService({ prisma, clock }),
    hrService: createHrService({ prisma, clock, cipher, env, fileService }),
    attendanceService: createAttendanceService({ prisma, clock, cipher, env }),
    timeEntryService: createTimeEntryService({ prisma, clock, taskService }),
    timesheetService: createTimesheetService({ prisma, clock, cipher, env }),
    departmentService: createDepartmentService({ prisma, clock }),
    teamService: createTeamService({ prisma, clock }),
    employeeService: createEmployeeService({ prisma, env, clock, cipher, cursorCodec, sessionService }),
  };
}

/**
 * Builds the Express app without listening, so tests can drive it with Supertest.
 * All infrastructure is injected; nothing here opens connections.
 */
export function createApp({
  env,
  logger,
  prisma,
  redis,
  storage,
  clock = systemClock,
  rateLimitStore = createMemoryRateLimitStore(),
  realtime = nullRealtime,
  metrics = null,
}) {
  const services = createServices({ env, prisma, redis, storage, clock });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId());
  if (metrics) app.use(httpMetricsMiddleware(metrics));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith(`${API_PREFIX}/health/`) },
      customProps: (req) => ({ requestId: req.id }),
    }),
  );
  app.use(
    helmet({
      // The API only serves JSON; the web app sets its own CSP.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      strictTransportSecurity: env.isProduction ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    }),
  );
  app.use(requestTimeout(env.REQUEST_TIMEOUT_MS));
  app.use(express.json({ limit: env.BODY_LIMIT, strict: true }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(sessionContext({ prisma, sessionService: services.sessionService }));
  app.use(agentContext({ prisma, agentTokens: services.monitoringService.agentTokens }));
  app.use(apiKeyContext({ prisma, clock }));
  // Runs deferred side effects (real-time pushes) once a request has succeeded.
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      for (const effect of req.ctx.afterCommit) {
        try {
          effect(realtime);
        } catch (err) {
          req.log?.warn({ err }, 'after-commit effect failed');
        }
      }
    });
    next();
  });
  app.use(csrfProtection({ env, sessionService: services.sessionService }));

  const deps = { env, prisma, redis, storage, clock, realtime, ...services };
  // Used only while the shared store is unreachable (see middleware/rate-limit.js).
  const fallbackStore = createMemoryRateLimitStore();
  const extras = {
    rateLimit: (className) => rateLimit(className, { store: rateLimitStore, fallbackStore, enabled: env.RATE_LIMIT_ENABLED }),
    idempotency: () => idempotency({ prisma, clock }),
  };
  app.use(API_PREFIX, buildApiRouter(deps, extras));

  if (env.swaggerEnabled) {
    const document = buildOpenApiDocument(listRoutes());
    app.get('/api/openapi.json', (_req, res) => res.json(document));
    app.use(
      '/api/docs',
      (_req, res, next) => {
        // Swagger UI needs scripts, styles and images; the JSON API keeps its strict CSP.
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
        next();
      },
      swaggerUi.serve,
      swaggerUi.setup(document, { customSiteTitle: 'Orbit API' }),
    );
  }

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
