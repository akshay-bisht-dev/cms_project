export const API_PREFIX = '/api/v1';

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_INVALID: 'CSRF_INVALID',
  ORG_SUSPENDED: 'ORG_SUSPENDED',
  ORGANIZATION_REQUIRED: 'ORGANIZATION_REQUIRED',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  SEAT_LIMIT_REACHED: 'SEAT_LIMIT_REACHED',
  LAST_OWNER: 'LAST_OWNER',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  OVERLAP: 'OVERLAP',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAVAILABLE: 'UNAVAILABLE',
  AGENT_REVOKED: 'AGENT_REVOKED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  CAPTURE_NOT_PERMITTED: 'CAPTURE_NOT_PERMITTED',
  LEGAL_HOLD: 'LEGAL_HOLD',
});

export const ORGANIZATION_STATUS = Object.freeze(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED']);
export const USER_STATUS = Object.freeze(['ACTIVE', 'LOCKED', 'DISABLED']);
export const MEMBER_TYPE = Object.freeze(['EMPLOYEE', 'CLIENT']);
export const MEMBER_STATUS = Object.freeze(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ARCHIVED']);

export const SYSTEM_ROLES = Object.freeze([
  'OWNER',
  'HR_MANAGER',
  'PROJECT_MANAGER',
  'TEAM_LEAD',
  'EMPLOYEE',
  'FINANCE_MANAGER',
  'CLIENT_USER',
]);

export const PERMISSION_SCOPES = Object.freeze(['self', 'team', 'department', 'project', 'org']);

export const PAGINATION = Object.freeze({ DEFAULT_LIMIT: 25, MAX_LIMIT: 100 });

/** Activity event types (append-only `activity_events`). Labels are shown in timelines. */
export const ACTIVITY_TYPES = Object.freeze({
  'attendance.clock_in': 'Clocked in',
  'attendance.clock_out': 'Clocked out',
  'attendance.break_start': 'Started a break',
  'attendance.break_end': 'Ended a break',
  'attendance.auto_closed': 'Session closed automatically (missed clock-out)',
  'attendance.corrected': 'Attendance corrected',
  'timer.started': 'Started the timer',
  'timer.paused': 'Paused the timer',
  'timer.resumed': 'Resumed the timer',
  'timer.stopped': 'Stopped the timer',
  'timer.switched': 'Switched task',
  'time.entry_added': 'Added time manually',
  'time.entry_edited': 'Edited a time entry',
  'time.entry_deleted': 'Deleted a time entry',
  'task.created': 'Created a task',
  'task.status_changed': 'Moved a task',
  'task.completed': 'Completed a task',
  'task.commented': 'Commented on a task',
  'timesheet.submitted': 'Submitted a timesheet',
  'timesheet.approved': 'Timesheet approved',
  'timesheet.rejected': 'Timesheet rejected',
  'agent.idle': 'No keyboard or mouse input (desktop app)',
});

/**
 * How a metric is obtained (FR-ACT-3). Measured: counted directly from records. Derived:
 * computed from measured values by a stated formula. Estimated: involves a forecast or assumption.
 */
export const METRIC_KINDS = Object.freeze(['measured', 'derived', 'estimated']);
