import { renderEmail } from '../services/email.js';

/** Sends one templated email. Throws on transport failure so BullMQ retries with backoff. */
export function createEmailProcessor({ transport, cipher, env, logger }) {
  return async (job) => {
    const { to, template, data, linkEnc } = job.data;
    const link = linkEnc ? cipher.decrypt(linkEnc) : undefined;
    const { subject, text } = renderEmail(template, { ...data, link });
    const info = await transport.sendMail({ from: env.SMTP_FROM, to, subject, text });
    logger.info({ template, jobId: job.id, messageId: info?.messageId }, 'email sent');
    return { messageId: info?.messageId ?? null };
  };
}
