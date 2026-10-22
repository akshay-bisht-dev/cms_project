// Employee profile field groups (FR-EMP-3, docs/permissions-matrix.md §4). Each group is read and
// written as a unit; a response includes a group only when the viewer's scope covers the employee.
export const FIELD_GROUPS = Object.freeze({
  basic: {
    read: 'employees.read',
    update: 'employees.update',
    fields: ['name', 'employeeCode', 'designation', 'departmentId', 'managerEmployeeId'],
  },
  work: {
    read: 'employees.fields.work.read',
    update: 'employees.update',
    fields: ['employmentType', 'joiningDate', 'workLocation', 'timeZone', 'skills'],
  },
  contact: {
    read: 'employees.fields.contact.read',
    update: 'employees.fields.contact.update',
    fields: ['phone'],
    selfService: true,
  },
  personal: {
    read: 'employees.fields.personal.read',
    update: 'employees.fields.personal.update',
    fields: ['personalEmail', 'address'],
    sensitive: true,
    selfService: true,
  },
  emergency: {
    read: 'employees.fields.emergency.read',
    update: 'employees.fields.emergency.update',
    fields: ['emergencyContact'],
    sensitive: true,
    selfService: true,
  },
  employment: {
    read: 'employees.fields.employment.read',
    update: 'employees.fields.employment.update',
    fields: ['probationEndDate', 'noticePeriodDays', 'lastWorkingDate'],
  },
  security: {
    read: 'employees.fields.security.read',
    update: null,
    fields: [],
  },
});

export const GROUP_OF_FIELD = Object.freeze(
  Object.fromEntries(Object.entries(FIELD_GROUPS).flatMap(([group, def]) => def.fields.map((f) => [f, group]))),
);

// Fields counted toward profile completion.
export const COMPLETION_FIELDS = Object.freeze([
  'employeeCode', 'designation', 'departmentId', 'managerUserId', 'employmentType', 'joiningDate',
  'workLocation', 'timeZone', 'phone', 'personalEmailEnc', 'addressEnc', 'emergencyContactEnc',
]);

/** Returns profile data with completionPct computed. Use for every profile write. */
export function withCompletion(profile) {
  return { ...profile, completionPct: profileCompletion(profile) };
}

export function profileCompletion(profile) {
  const filled = COMPLETION_FIELDS.filter((f) => profile[f] !== null && profile[f] !== undefined && profile[f] !== '').length;
  return Math.round((filled / COMPLETION_FIELDS.length) * 100);
}
