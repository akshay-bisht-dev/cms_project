// Email delivery goes through the outbox: the transaction that creates a token also enqueues the
// email, and the worker sends it. Links carry secrets, so they are stored encrypted in the payload.
import { enqueueOutbox } from './outbox.js';

export const EMAIL_TEMPLATES = Object.freeze({
  'verify-email': {
    subject: () => 'Verify your email for Orbit',
    text: ({ name, link }) => `Hi ${name},\n\nConfirm your email address to finish setting up Orbit:\n${link}\n\nThis link expires in 24 hours.`,
  },
  'reset-password': {
    subject: () => 'Reset your Orbit password',
    text: ({ name, link }) =>
      `Hi ${name},\n\nSomeone (hopefully you) asked to reset your Orbit password:\n${link}\n\nThis link expires in 30 minutes. If you did not ask for this, you can ignore this email.`,
  },
  invitation: {
    subject: ({ organizationName }) => `You're invited to join ${organizationName} on Orbit`,
    text: ({ name, organizationName, inviterName, link }) =>
      `Hi ${name},\n\n${inviterName ?? 'Your administrator'} invited you to join ${organizationName} on Orbit.\nAccept the invitation:\n${link}\n\nThis invitation expires in 7 days.`,
  },
  notification: {
    subject: ({ title }) => title,
    text: ({ name, title, body, link }) => `Hi ${name},\n\n${title}${body ? `\n\n${body}` : ''}${link ? `\n\nOpen in Orbit: ${link}` : ''}\n\nYou can change which emails you receive in your notification preferences.`,
  },
  'password-changed': {
    subject: () => 'Your Orbit password was changed',
    text: ({ name }) => `Hi ${name},\n\nYour Orbit password was just changed. If this was not you, reset your password immediately and contact your administrator.`,
  },
});

/** Renders a template. `link` must already be decrypted. */
export function renderEmail(template, data) {
  const t = EMAIL_TEMPLATES[template];
  if (!t) throw new Error(`Unknown email template "${template}"`);
  return { subject: t.subject(data), text: t.text(data) };
}

export function enqueueEmail(db, cipher, { to, template, data = {}, link, dedupeKey, organizationId = null }) {
  return enqueueOutbox(db, {
    type: 'email.send',
    organizationId,
    dedupeKey,
    payload: { to, template, data, linkEnc: link ? cipher.encrypt(link) : null },
  });
}
