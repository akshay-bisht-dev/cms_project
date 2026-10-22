import { emailSchema, idSchema, passwordSchema, z } from '@orbit/validation';

const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const token = z.string().min(20).max(200);

export const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(256) }).strict();
export const selectOrganizationBody = z.object({ organizationId: idSchema }).strict();
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).strict();
export const forgotPasswordBody = z.object({ email: emailSchema }).strict();
export const resetPasswordBody = z.object({ token, password: passwordSchema }).strict();
export const tokenBody = z.object({ token }).strict();
export const invitationQuery = z.object({ token }).strict();
export const acceptInvitationBody = z
  .object({ token, password: passwordSchema.optional(), name: z.string().trim().min(1).max(160).optional() })
  .strict();
export const sessionIdParams = z.object({ sessionId: idSchema }).strict();
export const mfaCodeBody = z.object({ code }).strict();
export const mfaVerifyBody = z
  .object({ code: code.optional(), recoveryCode: z.string().trim().min(8).max(32).optional() })
  .strict()
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), 'Provide either code or recoveryCode');
export const mfaDisableBody = z.object({ password: z.string().min(1).max(256), code }).strict();
