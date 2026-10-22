import { z } from 'zod';

// Organization settings are stored as one JSON document with a section per area. Defaults are
// merged on read, so adding a field never requires a data migration.
export const SETTINGS_SCHEMAS = Object.freeze({
  attendance: z
    .object({
      graceLateMinutes: z.number().int().min(0).max(240),
      graceEarlyMinutes: z.number().int().min(0).max(240),
      missedClockOutGraceHours: z.number().int().min(1).max(24),
      maxSessionHours: z.number().int().min(1).max(24),
      allowClockInOnLeave: z.boolean(),
    })
    .strict(),
  timeTracking: z
    .object({
      requireClockInForTimer: z.boolean(),
      autoClockInOnTimerStart: z.boolean(),
      allowManualEntries: z.boolean(),
      timesheetPeriod: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY']),
    })
    .strict(),
  security: z
    .object({
      mfaRequired: z.boolean(),
      sessionIdleMinutes: z.number().int().min(5).max(10080).nullable(),
    })
    .strict(),
  profile: z
    .object({
      skillsEnabled: z.boolean(),
      selfServiceFields: z.array(z.enum(['contact', 'personal', 'emergency'])),
    })
    .strict(),
});

export const SETTINGS_DEFAULTS = Object.freeze({
  attendance: { graceLateMinutes: 10, graceEarlyMinutes: 10, missedClockOutGraceHours: 4, maxSessionHours: 16, allowClockInOnLeave: false },
  timeTracking: { requireClockInForTimer: true, autoClockInOnTimerStart: true, allowManualEntries: true, timesheetPeriod: 'WEEKLY' },
  security: { mfaRequired: false, sessionIdleMinutes: null },
  profile: { skillsEnabled: true, selfServiceFields: ['contact', 'personal', 'emergency'] },
});

export const SETTINGS_SECTIONS = Object.freeze(Object.keys(SETTINGS_SCHEMAS));

export function mergeSettings(data) {
  const stored = data && typeof data === 'object' ? data : {};
  return Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section, { ...SETTINGS_DEFAULTS[section], ...(stored[section] ?? {}) }]));
}

export async function getOrganizationSettings(db, organizationId) {
  const row = await db.organizationSettings.findUnique({ where: { organizationId } });
  return { settings: mergeSettings(row?.data), version: row?.version ?? 0 };
}
