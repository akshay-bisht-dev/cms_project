import { emailSchema, idSchema, isoDateSchema, timeZoneSchema, z } from '@orbit/validation';
import { MEMBER_STATUS } from '@orbit/shared-constants';

const optionalText = (max) => z.string().trim().max(max).nullable();
const phone = z.string().trim().regex(/^\+?[0-9 ().-]{6,32}$/, 'Enter a valid phone number').nullable();
const employmentType = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN']).nullable();
const employeeCode = z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use up to 32 letters, digits, dashes or underscores').nullable();
const address = z
  .object({
    line1: z.string().trim().max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100),
    region: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code'),
  })
  .strict()
  .nullable();
const emergencyContact = z
  .object({ name: z.string().trim().min(1).max(160), relationship: z.string().trim().max(60), phone: z.string().trim().regex(/^\+?[0-9 ().-]{6,32}$/) })
  .strict()
  .nullable();

export const employeeIdParams = z.object({ employeeId: idSchema }).strict();
export const invitationIdParams = z.object({ invitationId: idSchema }).strict();

const statusFilter = z.enum([...MEMBER_STATUS, 'ALL']);

export const listEmployeesQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    departmentId: idSchema.optional(),
    teamId: idSchema.optional(),
    roleId: idSchema.optional(),
    managerEmployeeId: idSchema.optional(),
    // Comma-separated, e.g. status=ACTIVE,INVITED (the default) or status=ALL.
    status: z
      .string()
      .default('ACTIVE,INVITED')
      .transform((v) => v.split(',').map((s) => s.trim()))
      .pipe(z.array(statusFilter).min(1)),
    sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).default('name'),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const exportEmployeesQuery = listEmployeesQuery.omit({ cursor: true, limit: true });

const newEmployeeFields = {
  email: emailSchema,
  name: z.string().trim().min(1).max(160),
  employeeCode: employeeCode.optional(),
  designation: optionalText(120).optional(),
  departmentId: idSchema.nullable().optional(),
  managerEmployeeId: idSchema.nullable().optional(),
  teamIds: z.array(idSchema).max(20).default([]),
  roleIds: z.array(idSchema).min(1).max(20).optional(),
  employmentType: employmentType.optional(),
  joiningDate: isoDateSchema.nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
};

export const createEmployeeBody = z.object({ ...newEmployeeFields, sendInvitation: z.boolean().default(true) }).strict();
export const bulkInviteBody = z.object({ invitations: z.array(z.object(newEmployeeFields).strict()).min(1).max(50) }).strict();

export const updateEmployeeBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    employeeCode,
    designation: optionalText(120),
    departmentId: idSchema.nullable(),
    managerEmployeeId: idSchema.nullable(),
    employmentType,
    joiningDate: isoDateSchema.nullable(),
    workLocation: optionalText(120),
    timeZone: timeZoneSchema.nullable(),
    skills: z.array(z.string().trim().min(1).max(60)).max(50).nullable(),
    phone,
    personalEmail: emailSchema.nullable(),
    address,
    emergencyContact,
    probationEndDate: isoDateSchema.nullable(),
    noticePeriodDays: z.number().int().min(0).max(365).nullable(),
    lastWorkingDate: isoDateSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

export const offboardBody = z.object({ lastWorkingDate: isoDateSchema, reason: z.string().trim().max(500).optional() }).strict();
export const historyQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
