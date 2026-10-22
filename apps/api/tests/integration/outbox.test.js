import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, createClient } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createOrg } from '../helpers/factories.js';
import { createOutboxRelay } from '../../src/jobs/outbox-relay.js';
import { createEmailProcessor } from '../../src/jobs/email.js';
import { createMaintenanceProcessor } from '../../src/jobs/maintenance.js';
import { createFieldCipher } from '../../src/services/crypto.js';
import { enqueueOutbox } from '../../src/services/outbox.js';

const { app, prisma, env, clock } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
const logger = pino({ level: 'silent' });
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

function fakeQueue() {
  const jobs = new Map();
  return { jobs, add: async (name, data, opts) => jobs.set(opts.jobId, { name, data }) };
}

describe('transactional outbox relay', () => {
  it('publishes committed events once and marks them published', async () => {
    const { owner } = await createOrg(prisma);
    await createClient(app).post('/auth/forgot-password', { email: owner.email });
    const email = fakeQueue();
    const relay = createOutboxRelay({ prisma, queues: { email }, logger, clock });

    expect(await relay()).toBe(1);
    expect(await relay()).toBe(0);
    const [job] = [...email.jobs.values()];
    expect(job).toMatchObject({ name: 'email.send', data: { to: owner.email, template: 'reset-password' } });
    expect(job.data.linkEnc).toMatch(/^v1\./);
    expect((await prisma.outboxEvent.findFirst()).publishedAt).not.toBeNull();
  });

  it('ignores duplicate enqueues with the same dedupe key', async () => {
    await enqueueOutbox(prisma, { type: 'email.send', payload: { to: 'a@b.test' }, dedupeKey: 'same-key' });
    await enqueueOutbox(prisma, { type: 'email.send', payload: { to: 'a@b.test' }, dedupeKey: 'same-key' });
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('leaves events with no destination queue unpublished and records the error', async () => {
    await enqueueOutbox(prisma, { type: 'nobody.listens', payload: {}, dedupeKey: 'orphan' });
    const relay = createOutboxRelay({ prisma, queues: {}, logger, clock });
    expect(await relay()).toBe(0);
    const event = await prisma.outboxEvent.findFirst();
    expect(event).toMatchObject({ publishedAt: null, attempts: 1, lastError: 'no queue for event type' });
  });

  it('rolls back the claim when enqueueing fails, so the event is retried', async () => {
    await enqueueOutbox(prisma, { type: 'email.send', payload: { to: 'a@b.test' }, dedupeKey: 'retry-me' });
    const failing = { add: async () => { throw new Error('redis down'); } };
    await expect(createOutboxRelay({ prisma, queues: { email: failing }, logger, clock })()).rejects.toThrow('redis down');
    expect((await prisma.outboxEvent.findFirst()).publishedAt).toBeNull();
    expect(await createOutboxRelay({ prisma, queues: { email: fakeQueue() }, logger, clock })()).toBe(1);
  });
});

describe('email delivery job', () => {
  it('decrypts the link, renders the template and sends through the transport', async () => {
    const sent = [];
    const transport = { sendMail: async (msg) => (sent.push(msg), { messageId: 'm-1' }) };
    const process = createEmailProcessor({ transport, cipher, env, logger });
    const result = await process({
      id: 'job-1',
      data: { to: 'nora@example.test', template: 'reset-password', data: { name: 'Nora' }, linkEnc: cipher.encrypt('http://localhost:3000/reset-password?token=abc') },
    });
    expect(result).toEqual({ messageId: 'm-1' });
    expect(sent[0]).toMatchObject({ to: 'nora@example.test', subject: 'Reset your Orbit password' });
    expect(sent[0].text).toContain('http://localhost:3000/reset-password?token=abc');
  });

  it('propagates transport failures so BullMQ retries', async () => {
    const transport = { sendMail: async () => { throw new Error('SMTP 421'); } };
    const process = createEmailProcessor({ transport, cipher, env, logger });
    await expect(process({ id: 'j', data: { to: 'a@b.test', template: 'password-changed', data: { name: 'A' } } })).rejects.toThrow('SMTP 421');
  });
});

describe('maintenance jobs', () => {
  it('purges expired idempotency keys across all organizations', async () => {
    const { org, owner } = await createOrg(prisma);
    await prisma.idempotencyKey.createMany({
      data: [
        { organizationId: org.id, userId: owner.id, key: 'old-key-0001', methodPath: 'POST /x', requestHash: 'a'.repeat(64), expiresAt: new Date(Date.now() - 1000) },
        { organizationId: org.id, userId: owner.id, key: 'new-key-0001', methodPath: 'POST /x', requestHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 1e6) },
      ],
    });
    const run = createMaintenanceProcessor({ prisma, logger });
    expect(await run({ name: 'purge-idempotency-keys' })).toEqual({ deleted: 1 });
    await expect(run({ name: 'nope' })).rejects.toThrow(/Unknown maintenance job/);
  });
});
