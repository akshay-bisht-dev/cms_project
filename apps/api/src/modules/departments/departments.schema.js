import { idSchema, z } from '@orbit/validation';

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'Use up to 32 letters, digits, dashes or underscores');

export const departmentIdParams = z.object({ departmentId: idSchema }).strict();
export const listDepartmentsQuery = z.object({ includeArchived: z.enum(['true', 'false']).default('false') }).strict();

export const createDepartmentBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    code,
    parentId: idSchema.nullable().optional(),
    managerEmployeeId: idSchema.nullable().optional(),
  })
  .strict();

export const updateDepartmentBody = createDepartmentBody
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');
