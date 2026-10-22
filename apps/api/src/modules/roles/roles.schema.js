import { idSchema, z } from '@orbit/validation';
import { PERMISSION_SCOPES } from '@orbit/shared-constants';

const grant = z.object({ key: z.string().min(3).max(96), scope: z.enum(PERMISSION_SCOPES) }).strict();
const grants = z.array(grant).max(200);

export const roleIdParams = z.object({ roleId: idSchema }).strict();
export const employeeIdParams = z.object({ employeeId: idSchema }).strict();

export const createRoleBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    permissions: grants,
  })
  .strict();

export const updateRoleBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable(),
    permissions: grants,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

export const assignRolesBody = z.object({ roleIds: z.array(idSchema).min(1).max(20) }).strict();
export const overridesBody = z.object({ deny: z.array(z.string().min(3).max(96)).max(200), reason: z.string().max(500).optional() }).strict();
