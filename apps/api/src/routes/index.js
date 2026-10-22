import { Router } from 'express';
import { mountModule } from './define-routes.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { organizationRoutes } from '../modules/organizations/organizations.routes.js';
import { roleRoutes } from '../modules/roles/roles.routes.js';
import { departmentRoutes } from '../modules/departments/departments.routes.js';
import { teamRoutes } from '../modules/teams/teams.routes.js';
import { employeeRoutes } from '../modules/employees/employees.routes.js';
import { invitationRoutes } from '../modules/employees/invitations.routes.js';
import { notificationRoutes } from '../modules/notifications/notifications.routes.js';
import { dashboardRoutes } from '../modules/dashboard/dashboard.routes.js';
import { workRoutes } from '../modules/attendance/work.routes.js';
import { attendanceRoutes } from '../modules/attendance/attendance.routes.js';
import { timeEntryRoutes } from '../modules/time-tracking/time-entries.routes.js';
import { timesheetRoutes } from '../modules/timesheets/timesheets.routes.js';
import { projectRoutes } from '../modules/projects/projects.routes.js';
import { taskRoutes } from '../modules/tasks/tasks.routes.js';
import { calendarRoutes } from '../modules/calendar/calendar.routes.js';
import { monitoringRoutes } from '../modules/monitoring/monitoring.routes.js';
import { activityRoutes } from '../modules/activity/activity.routes.js';
import { reportRoutes } from '../modules/reports/reports.routes.js';
import { crmRoutes, salesRoutes } from '../modules/crm/crm.routes.js';
import { ticketRoutes } from '../modules/tickets/tickets.routes.js';
import { financeRoutes } from '../modules/finance/finance.routes.js';
import { portalRoutes } from '../modules/portal/portal.routes.js';
import { leaveRoutes } from '../modules/leave/leave.routes.js';
import { integrationRoutes } from '../modules/integrations/integrations.routes.js';
import { customFieldRoutes } from '../modules/custom-fields/custom-fields.routes.js';
import { hrRoutes } from '../modules/hr/hr.routes.js';

/** Builds every module and mounts it under /api/v1. */
export function buildApiRouter(deps, extras) {
  const router = Router();
  const modules = [
    healthRoutes(deps),
    authRoutes(deps),
    organizationRoutes(deps),
    roleRoutes(deps),
    departmentRoutes(deps),
    teamRoutes(deps),
    employeeRoutes(deps),
    invitationRoutes(deps),
    notificationRoutes(deps),
    dashboardRoutes(deps),
    workRoutes(deps),
    attendanceRoutes(deps),
    timeEntryRoutes(deps),
    timesheetRoutes(deps),
    projectRoutes(deps),
    taskRoutes(deps),
    calendarRoutes(deps),
    monitoringRoutes(deps),
    activityRoutes(deps),
    reportRoutes(deps),
    crmRoutes(deps),
    salesRoutes(deps),
    ticketRoutes(deps),
    financeRoutes(deps),
    portalRoutes(deps),
    leaveRoutes(deps),
    integrationRoutes(deps),
    customFieldRoutes(deps),
    hrRoutes(deps),
  ];
  for (const module of modules) {
    const { basePath, router: moduleRouter } = mountModule(module, extras);
    router.use(basePath, moduleRouter);
  }
  return router;
}
