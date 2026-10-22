import { idSchema, z } from '@orbit/validation';

export const teamIdParams = z.object({ teamId: idSchema }).strict();
export const listTeamsQuery = z
  .object({ includeArchived: z.enum(['true', 'false']).default('false'), departmentId: idSchema.optional() })
  .strict();

export const createTeamBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    departmentId: idSchema.nullable().optional(),
    leadEmployeeId: idSchema.nullable().optional(),
    memberEmployeeIds: z.array(idSchema).max(500).default([]),
  })
  .strict();

export const updateTeamBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    departmentId: idSchema.nullable(),
    leadEmployeeId: idSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

export const setTeamMembersBody = z.object({ employeeIds: z.array(idSchema).max(500) }).strict();
