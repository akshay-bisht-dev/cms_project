import { PUBLIC, SESSION } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendNoContent, sendOk } from '../../utils/response.js';
import {
  acceptInvitationBody,
  changePasswordBody,
  forgotPasswordBody,
  invitationQuery,
  loginBody,
  mfaCodeBody,
  mfaDisableBody,
  mfaVerifyBody,
  resetPasswordBody,
  selectOrganizationBody,
  sessionIdParams,
  tokenBody,
} from './auth.schema.js';

const ACCEPTED = { message: 'If the account exists, we have sent an email with the next steps.' };

export function authRoutes({ authService, sessionService }) {
  const issue = (res, { token, session }) => sessionService.setCookies(res, token, session);
  const tags = ['Auth'];

  return defineRoutes('/auth', (r) => {
    r.post('/login', { permission: PUBLIC, body: loginBody, rateLimit: 'auth-strict', tags, summary: 'Sign in with email and password' }, async (req, res) => {
      const result = await authService.login(req.ctx, req.valid.body);
      issue(res, result);
      sendOk(res, { status: result.status, organizations: result.organizations });
    });

    r.post(
      '/select-organization',
      { permission: SESSION, body: selectOrganizationBody, tags, summary: 'Choose or switch the active organization' },
      async (req, res) => {
        issue(res, await authService.selectOrganization(req.ctx, req.valid.body));
        // Permissions change with the organization; clients refetch GET /auth/me.
        sendOk(res, { organizationId: req.valid.body.organizationId });
      },
    );

    r.post('/logout', { permission: SESSION, allowMfaPending: true, tags, summary: 'Sign out of this session' }, async (req, res) => {
      await authService.logout(req.ctx);
      sessionService.clearCookies(res);
      sendNoContent(res);
    });

    r.get('/me', { permission: SESSION, allowMfaPending: true, allowMfaEnrollment: true, tags, summary: 'Current user, organization and permissions' }, async (req, res) => {
      sendOk(res, await authService.me(req.ctx));
    });

    r.get('/sessions', { permission: SESSION, tags, summary: 'List my active sessions' }, async (req, res) => {
      sendOk(res, await authService.listSessions(req.ctx));
    });

    r.delete('/sessions/:sessionId', { permission: SESSION, params: sessionIdParams, tags, summary: 'Revoke one of my sessions' }, async (req, res) => {
      await authService.revokeSession(req.ctx, req.valid.params.sessionId);
      sendNoContent(res);
    });

    r.post('/change-password', { permission: SESSION, body: changePasswordBody, rateLimit: 'auth-strict', tags, summary: 'Change my password (signs out other sessions)' }, async (req, res) => {
      issue(res, await authService.changePassword(req.ctx, req.valid.body));
      sendNoContent(res);
    });

    r.post('/forgot-password', { permission: PUBLIC, body: forgotPasswordBody, rateLimit: 'auth-strict', tags, summary: 'Request a password reset email' }, async (req, res) => {
      await authService.forgotPassword(req.ctx, req.valid.body);
      sendOk(res, ACCEPTED, { status: 202 });
    });

    r.post('/reset-password', { permission: PUBLIC, body: resetPasswordBody, rateLimit: 'auth-strict', tags, summary: 'Set a new password with a reset token' }, async (req, res) => {
      await authService.resetPassword(req.ctx, req.valid.body);
      sendNoContent(res);
    });

    r.post('/verify-email', { permission: PUBLIC, body: tokenBody, rateLimit: 'auth-strict', tags, summary: 'Confirm an email address' }, async (req, res) => {
      await authService.verifyEmail(req.ctx, req.valid.body);
      sendNoContent(res);
    });

    r.post('/resend-verification', { permission: PUBLIC, body: forgotPasswordBody, rateLimit: 'auth-strict', tags, summary: 'Resend the verification email' }, async (req, res) => {
      await authService.resendVerification(req.valid.body);
      sendOk(res, ACCEPTED, { status: 202 });
    });

    r.get('/invitation', { permission: PUBLIC, query: invitationQuery, rateLimit: 'auth-strict', tags, summary: 'Look up an invitation by token' }, async (req, res) => {
      sendOk(res, await authService.getInvitation(req.valid.query));
    });

    r.post('/accept-invitation', { permission: PUBLIC, body: acceptInvitationBody, rateLimit: 'auth-strict', tags, summary: 'Accept an invitation (sets a password for new accounts)' }, async (req, res) => {
      sendOk(res, await authService.acceptInvitation(req.ctx, req.valid.body));
    });

    r.post('/mfa/setup', { permission: SESSION, allowMfaEnrollment: true, tags, summary: 'Start TOTP enrollment' }, async (req, res) => {
      sendOk(res, await authService.mfaSetup(req.ctx));
    });

    r.post('/mfa/enable', { permission: SESSION, body: mfaCodeBody, allowMfaEnrollment: true, rateLimit: 'auth-strict', tags, summary: 'Confirm TOTP enrollment; returns recovery codes once' }, async (req, res) => {
      const { recoveryCodes, ...rotated } = await authService.mfaEnable(req.ctx, req.valid.body);
      issue(res, rotated);
      sendOk(res, { recoveryCodes });
    });

    r.post('/mfa/verify', { permission: SESSION, body: mfaVerifyBody, allowMfaPending: true, rateLimit: 'auth-strict', tags, summary: 'Complete sign-in with a TOTP or recovery code' }, async (req, res) => {
      issue(res, await authService.mfaVerify(req.ctx, req.valid.body));
      sendNoContent(res);
    });

    r.post('/mfa/disable', { permission: SESSION, body: mfaDisableBody, rateLimit: 'auth-strict', tags, summary: 'Turn off two-factor authentication' }, async (req, res) => {
      await authService.mfaDisable(req.ctx, req.valid.body);
      sendNoContent(res);
    });
  });
}

