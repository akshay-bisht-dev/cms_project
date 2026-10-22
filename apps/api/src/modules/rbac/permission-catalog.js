// The permission catalog (docs/permissions-matrix.md). Synced into the `permissions` table on
// startup. Scopes are listed narrowest → widest; a grant must use one of the allowed scopes.
const S = 'self';
const T = 'team';
const D = 'department';
const P = 'project';
const O = 'org';

const ALL = [S, T, D, P, O];
const ORG = [O];

const entries = [
  // Organization & administration
  ['org.settings.read', 'organization', 'View organization profile and settings', ORG],
  ['org.settings.manage', 'organization', 'Edit organization profile and settings', ORG],
  ['org.billing.manage', 'organization', 'Manage subscription and limits', ORG],
  ['org.data.manage', 'organization', 'Export or erase organization data', ORG],
  ['roles.manage', 'access', 'Create and edit roles and assign them to members', ORG],
  ['departments.manage', 'structure', 'Create and edit departments', ORG],
  ['teams.manage', 'structure', 'Create and edit teams and their members', [T, O]],
  ['customfields.manage', 'platform', 'Define custom fields', ORG],
  ['integrations.manage', 'platform', 'Manage integrations', ORG],
  ['webhooks.manage', 'platform', 'Manage webhooks', ORG],
  ['apikeys.manage', 'platform', 'Manage API keys', ORG],
  ['audit.read', 'platform', 'Read audit logs', ORG],

  // People
  ['employees.read', 'people', 'View the employee directory and basic profile fields', ALL],
  ['employees.fields.work.read', 'people', 'View work details (employment type, location, joining date)', ALL],
  ['employees.fields.contact.read', 'people', 'View contact details (phone)', ALL],
  ['employees.fields.contact.update', 'people', 'Edit contact details', [S, O]],
  ['employees.fields.personal.read', 'people', 'View personal email and address', [S, O]],
  ['employees.fields.personal.update', 'people', 'Edit personal email and address', [S, O]],
  ['employees.fields.emergency.read', 'people', 'View emergency contact', [S, O]],
  ['employees.fields.emergency.update', 'people', 'Edit emergency contact', [S, O]],
  ['employees.fields.employment.read', 'people', 'View employment terms (probation, notice, last working day)', [S, D, O]],
  ['employees.fields.employment.update', 'people', 'Edit employment terms', ORG],
  ['employees.fields.security.read', 'people', 'View account security status (MFA, last login)', [S, O]],
  ['employees.create', 'people', 'Add employees', ORG],
  ['employees.update', 'people', 'Edit employee basic and work fields', [T, D, O]],
  ['employees.deactivate', 'people', 'Activate, deactivate, offboard and archive employees', ORG],
  ['employees.export', 'people', 'Export employee records', ORG],
  ['employees.history.read', 'people', 'View profile change history', [S, D, O]],
  ['invitations.manage', 'people', 'Invite employees and manage invitations', ORG],
  ['documents.hr.read', 'people', 'View employment documents', [S, O]],
  ['documents.hr.manage', 'people', 'Manage employment documents', ORG],

  // Attendance & time
  ['attendance.self', 'attendance', 'Clock in/out and take breaks', [S]],
  ['attendance.read', 'attendance', 'View attendance records', ALL],
  ['attendance.correct.request', 'attendance', 'Request attendance corrections', [S]],
  ['attendance.correct.approve', 'attendance', 'Approve attendance corrections', [T, D, O]],
  ['time.self', 'time', 'Use the timer', [S]],
  ['time.manual', 'time', 'Add and edit own manual time entries', [S]],
  ['time.read', 'time', 'View time entries', ALL],
  ['time.edit.others', 'time', "Edit other members' time entries", [P, O]],
  ['timesheets.submit', 'timesheets', 'Submit own timesheets', [S]],
  ['timesheets.read', 'timesheets', 'View timesheets', ALL],
  ['timesheets.approve', 'timesheets', 'Approve or reject timesheets', [T, D, P, O]],
  ['timesheets.unlock', 'timesheets', 'Reopen approved timesheets', ORG],

  // Monitoring
  ['monitoring.self', 'monitoring', 'View own monitoring status, captures and agents', [S]],
  ['monitoring.policy.read', 'monitoring', 'View capture policies', [S, O]],
  ['monitoring.policy.manage', 'monitoring', 'Manage capture policies', ORG],
  ['monitoring.screenshots.read', 'monitoring', 'View screenshots', ALL],
  ['monitoring.screenshots.download', 'monitoring', 'Download screenshots', ALL],
  ['monitoring.screenshots.delete', 'monitoring', 'Delete screenshots', ORG],
  ['monitoring.legalhold.manage', 'monitoring', 'Manage legal holds', ORG],
  ['monitoring.agents.manage', 'monitoring', 'Manage desktop agents', [S, O]],

  // Projects & tasks
  ['projects.read', 'projects', 'View projects', [P, O]],
  ['projects.create', 'projects', 'Create projects', ORG],
  ['projects.manage', 'projects', 'Edit projects, members and milestones', [P, O]],
  ['projects.budget.read', 'projects', 'View project budgets', [P, O]],
  ['tasks.read', 'tasks', 'View tasks', [P, O]],
  ['tasks.create', 'tasks', 'Create tasks', [P, O]],
  ['tasks.update', 'tasks', 'Edit and assign tasks', [P, O]],

  // CRM & tickets
  ['clients.read', 'crm', 'View clients', [P, O]],
  ['clients.manage', 'crm', 'Manage clients', ORG],
  ['leads.manage', 'crm', 'Manage leads', ORG],
  ['opportunities.manage', 'crm', 'Manage opportunities', ORG],
  ['quotes.manage', 'crm', 'Manage quotes', ORG],
  ['tickets.read', 'tickets', 'View support tickets', [S, T, P, O]],
  ['tickets.manage', 'tickets', 'Manage support tickets', [S, T, P, O]],
  ['tickets.client', 'tickets', 'Client portal: create and comment on own tickets', [S]],

  // Leave
  ['leave.self', 'leave', 'Request and cancel own leave', [S]],
  ['leave.read', 'leave', 'View leave', ALL],
  ['leave.approve', 'leave', 'Approve leave requests', [T, D, O]],
  ['leave.policy.manage', 'leave', 'Manage leave types and policies', ORG],
  ['leave.balance.adjust', 'leave', 'Adjust leave balances', ORG],

  // Finance
  ['finance.expenses.submit', 'finance', 'Submit own expenses', [S]],
  ['finance.expenses.approve', 'finance', 'Approve expenses', [P, O]],
  ['finance.invoices.read', 'finance', 'View invoices', [P, O]],
  ['finance.invoices.manage', 'finance', 'Manage invoices', ORG],
  ['finance.payments.record', 'finance', 'Record payments', ORG],
  ['finance.rates.manage', 'finance', 'Manage billing rates', ORG],
  ['finance.cost.read', 'finance', 'View cost rates and margins', ORG],

  // Reports & dashboard
  ['dashboard.read', 'reports', 'View dashboards', ALL],
  ['reports.attendance.read', 'reports', 'Attendance reports', ALL],
  ['reports.projects.read', 'reports', 'Project reports', [T, P, O]],
  ['reports.monitoring.read', 'reports', 'Monitoring reports', [S, T, P, O]],
  ['reports.crm.read', 'reports', 'CRM reports', ORG],
  ['reports.finance.read', 'reports', 'Finance reports', [P, O]],
  ['reports.export', 'reports', 'Export reports', ALL],
];

export const PERMISSION_CATALOG = Object.freeze(
  entries.map(([key, module, description, allowedScopes]) => Object.freeze({ key, module, description, allowedScopes })),
);

export const PERMISSIONS_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));

export const SCOPE_TO_DB = Object.freeze({ self: 'SELF', team: 'TEAM', department: 'DEPARTMENT', project: 'PROJECT', org: 'ORG' });
export const SCOPE_FROM_DB = Object.freeze(Object.fromEntries(Object.entries(SCOPE_TO_DB).map(([k, v]) => [v, k])));

/** Upserts the catalog into the permissions table. Idempotent; safe to run on every boot. */
export async function syncPermissionCatalog(prisma) {
  await prisma.$transaction(
    PERMISSION_CATALOG.map((p) =>
      prisma.permission.upsert({
        where: { key: p.key },
        update: { module: p.module, description: p.description, allowedScopes: p.allowedScopes },
        create: { key: p.key, module: p.module, description: p.description, allowedScopes: p.allowedScopes },
      }),
    ),
  );
}
