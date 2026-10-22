import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueOutbox } from '../../services/outbox.js';
import { signPayload } from './webhook-signature.js';
import { postWebhook, validateWebhookUrl } from './ssrf.js';
import { employeeCreatedHooks, offboardingHooks } from '../employees/employees.service.js';

/** Events integrators can subscribe to. "*" subscribes to all. */
export const WEBHOOK_EVENTS = Object.freeze({
  'employee.created': 'An employee was added',
  'employee.deactivated': 'An employee was deactivated or offboarded',
  'leave.approved': 'A leave request was approved',
  'leave.cancelled': 'A leave request was cancelled',
  'project.created': 'A project was created',
  'task.completed': 'A task was completed',
  'timesheet.approved': 'A timesheet was approved',
  'client.created': 'A client was created',
  'ticket.created': 'A support ticket was opened',
  'ticket.resolved': 'A support ticket was resolved',
  'invoice.issued': 'An invoice was issued',
  'invoice.paid': 'An invoice became fully paid',
  'expense.approved': 'An expense was approved',
});

/** Retry delays after attempt 1, 2, … (seconds); after the last, the delivery fails. */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const DISABLE_AFTER_FAILURES = 20;
const CLAIM_LEASE_MS = 120_000;

/**
 * Records a domain event for webhooks, in the caller's transaction (outbox: delivered only if the
 * change commits). The worker fans it out to subscribed webhooks.
 */
export async function emitWebhookEvent(db, { organizationId, type, data, occurredAt = new Date() }) {
  if (!WEBHOOK_EVENTS[type] && type !== 'ping') throw new Error(`Unknown webhook event "${type}"`);
  const eventId = randomUUID();
  await enqueueOutbox(db, { type: 'webhook.event', payload: { organizationId, eventId, type, occurredAt: occurredAt.toISOString(), data }, dedupeKey: `webhook-event:${eventId}`, organizationId });
  return eventId;
}

/** One delivery row per subscribed, active webhook. Idempotent (unique fan-out key). */
export async function fanOutEvent({ prisma, clock }, { organizationId, eventId, type, occurredAt, data }) {
  const hooks = await prisma.webhook.findMany({ where: { organizationId, isActive: true } });
  let created = 0;
  for (const hook of hooks) {
    const events = hook.events ?? [];
    if (type !== 'ping' && !events.includes('*') && !events.includes(type)) continue;
    try {
      await prisma.webhookDelivery.create({
        data: { organizationId, webhookId: hook.id, eventId, eventType: type, payload: { id: eventId, type, createdAt: occurredAt, organizationId, data }, fanoutKey: `${hook.id}:${eventId}`, nextRetryAt: clock.now() },
      });
      created += 1;
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
    }
  }
  return { created };
}

/**
 * Sends due deliveries. Rows are claimed with a short lease (FOR UPDATE SKIP LOCKED), so several
 * workers never send the same attempt twice. 2xx = delivered; anything else (status, timeout,
 * refused private address) schedules the next retry, until MAX_ATTEMPTS.
 */
export async function deliverDue({ prisma, clock, cipher, transport = postWebhook, logger, limit = 50 }) {
  const now = clock.now();
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM webhook_deliveries
      WHERE status = 'PENDING' AND next_retry_at <= ${now}
      ORDER BY next_retry_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length) {
      await tx.$executeRaw`UPDATE webhook_deliveries SET next_retry_at = ${new Date(now.getTime() + CLAIM_LEASE_MS)} WHERE id IN (${Prisma.join(rows.map((r) => r.id))})`;
    }
    return rows.map((r) => r.id);
  });
  let delivered = 0;
  for (const id of claimed) {
    const d = await prisma.unscoped.webhookDelivery.findUnique({ where: { id }, include: { webhook: true } });
    if (!d || d.status !== 'PENDING') continue;
    const attempt = d.attempt + 1;
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const secret = cipher.decrypt(d.webhook.secretEnc);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Orbit-Webhooks/1',
      'x-orbit-event': d.eventType,
      'x-orbit-delivery': d.id,
      'x-orbit-timestamp': String(timestamp),
      'x-orbit-signature': signPayload({ secret, timestamp, deliveryId: d.id, body }),
    };
    let ok = false;
    let statusCode = null;
    let responseMs = null;
    let error = null;
    if (!d.webhook.isActive) error = 'Webhook disabled';
    else {
      try {
        const res = await transport(d.webhook.url, { headers, body });
        statusCode = res.status;
        responseMs = res.ms;
        ok = res.status >= 200 && res.status < 300;
        if (!ok) error = `HTTP ${res.status}`;
      } catch (err) {
        error = (err.code ? `${err.code}: ` : '') + (err.message ?? 'Delivery failed');
      }
    }
    const final = ok || attempt >= MAX_ATTEMPTS || !d.webhook.isActive;
    await prisma.webhookDelivery.updateMany({
      where: { organizationId: d.organizationId, id: d.id },
      data: {
        attempt,
        statusCode,
        responseMs,
        error: error?.slice(0, 500) ?? null,
        status: ok ? 'SUCCEEDED' : final ? 'FAILED' : 'PENDING',
        deliveredAt: ok ? clock.now() : null,
        nextRetryAt: final ? null : new Date(clock.now().getTime() + RETRY_DELAYS_S[attempt - 1] * 1000),
      },
    });
    if (ok) {
      delivered += 1;
      if (d.webhook.consecutiveFailures) await prisma.webhook.updateMany({ where: { organizationId: d.organizationId, id: d.webhookId }, data: { consecutiveFailures: 0 } });
    } else if (final && d.webhook.isActive) {
      const failures = d.webhook.consecutiveFailures + 1;
      await prisma.webhook.updateMany({
        where: { organizationId: d.organizationId, id: d.webhookId },
        data: { consecutiveFailures: failures, ...(failures >= DISABLE_AFTER_FAILURES ? { isActive: false, disabledReason: `Disabled after ${failures} failed deliveries in a row` } : {}) },
      });
    }
  }
  logger?.debug?.({ claimed: claimed.length, delivered }, 'webhook deliveries');
  return { attempted: claimed.length, delivered };
}

// Employee lifecycle events come from the employee module's hooks (registered once per process).
let hooksRegistered = false;
function registerEmployeeHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  employeeCreatedHooks.push((tx, ctx, member) => emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'employee.created', data: { employeeId: member.id } }));
  offboardingHooks.push((tx, ctx, member) => emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'employee.deactivated', data: { employeeId: member.id } }));
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

export function createWebhookService({ prisma, clock, cipher, env }) {
  registerEmployeeHooks();
  const allowHttp = !env.isProduction;
  const serialize = (w) => ({ id: w.id, url: w.url, description: w.description, events: w.events, isActive: w.isActive, consecutiveFailures: w.consecutiveFailures, disabledReason: w.disabledReason, createdAt: w.createdAt });

  function checkEvents(events) {
    const bad = events.filter((e) => e !== '*' && !WEBHOOK_EVENTS[e]);
    if (bad.length) throw new ValidationError([{ path: 'body.events', message: `Unknown events: ${bad.join(', ')}` }]);
  }
  function checkUrl(url) {
    const problem = validateWebhookUrl(url, { allowHttp });
    if (problem) throw new ValidationError([{ path: 'body.url', message: problem }]);
  }
  async function load(ctx, webhookId) {
    const w = await prisma.webhook.findFirst({ where: { organizationId: ctx.orgId, id: webhookId } });
    if (!w) throw new NotFoundError('Webhook not found');
    return w;
  }

  return {
    events: () => Object.entries(WEBHOOK_EVENTS).map(([type, description]) => ({ type, description })),

    async list(ctx) {
      return (await prisma.webhook.findMany({ where: { organizationId: ctx.orgId }, orderBy: { createdAt: 'asc' } })).map(serialize);
    },

    /** The signing secret is returned once, here; afterwards only rotation reveals a new one. */
    async create(ctx, { url, events, description }) {
      checkUrl(url);
      checkEvents(events);
      const secret = newSecret();
      const w = await prisma.webhook.create({ data: { organizationId: ctx.orgId, url, events, description: description ?? null, secretEnc: cipher.encrypt(secret), createdById: ctx.userId } });
      await recordAudit(prisma, ctx, { action: 'webhooks.created', targetType: 'webhook', targetId: w.id, diff: { url, events } });
      return { ...serialize(w), secret };
    },

    async update(ctx, webhookId, patch) {
      const w = await load(ctx, webhookId);
      if (patch.url) checkUrl(patch.url);
      if (patch.events) checkEvents(patch.events);
      const updated = await prisma.webhook.update({
        where: { organizationId_id: { organizationId: ctx.orgId, id: w.id } },
        data: { ...patch, ...(patch.isActive ? { consecutiveFailures: 0, disabledReason: null } : {}) },
      });
      await recordAudit(prisma, ctx, { action: 'webhooks.updated', targetType: 'webhook', targetId: w.id, diff: patch });
      return serialize(updated);
    },

    async rotateSecret(ctx, webhookId) {
      const w = await load(ctx, webhookId);
      const secret = newSecret();
      await prisma.webhook.updateMany({ where: { organizationId: ctx.orgId, id: w.id }, data: { secretEnc: cipher.encrypt(secret) } });
      await recordAudit(prisma, ctx, { action: 'webhooks.secret_rotated', targetType: 'webhook', targetId: w.id });
      return { secret };
    },

    async remove(ctx, webhookId) {
      const w = await load(ctx, webhookId);
      await prisma.webhook.deleteMany({ where: { organizationId: ctx.orgId, id: w.id } });
      await recordAudit(prisma, ctx, { action: 'webhooks.deleted', targetType: 'webhook', targetId: w.id, diff: { url: w.url } });
    },

    async deliveries(ctx, webhookId) {
      const w = await load(ctx, webhookId);
      const rows = await prisma.webhookDelivery.findMany({ where: { organizationId: ctx.orgId, webhookId: w.id }, orderBy: { createdAt: 'desc' }, take: 100 });
      return rows.map((d) => ({ id: d.id, eventId: d.eventId, eventType: d.eventType, status: d.status, attempt: d.attempt, statusCode: d.statusCode, responseMs: d.responseMs, error: d.error, nextRetryAt: d.nextRetryAt, deliveredAt: d.deliveredAt, replayOfId: d.replayOfId, createdAt: d.createdAt }));
    },

    /** Re-sends an event as a new delivery (new id and signature; the receiver sees a fresh nonce). */
    async replay(ctx, webhookId, deliveryId) {
      const w = await load(ctx, webhookId);
      if (!w.isActive) throw new BusinessRuleError('Re-enable the webhook before replaying');
      const original = await prisma.webhookDelivery.findFirst({ where: { organizationId: ctx.orgId, webhookId: w.id, id: deliveryId } });
      if (!original) throw new NotFoundError('Delivery not found');
      const d = await prisma.webhookDelivery.create({ data: { organizationId: ctx.orgId, webhookId: w.id, eventId: original.eventId, eventType: original.eventType, payload: original.payload, replayOfId: original.id, nextRetryAt: clock.now() } });
      await recordAudit(prisma, ctx, { action: 'webhooks.replayed', targetType: 'webhook_delivery', targetId: d.id, diff: { of: original.id } });
      return { id: d.id };
    },

    async ping(ctx, webhookId) {
      const w = await load(ctx, webhookId);
      const eventId = randomUUID();
      const d = await prisma.webhookDelivery.create({
        data: { organizationId: ctx.orgId, webhookId: w.id, eventId, eventType: 'ping', payload: { id: eventId, type: 'ping', createdAt: clock.now().toISOString(), organizationId: ctx.orgId, data: { message: 'Hello from Orbit' } }, fanoutKey: `${w.id}:${eventId}`, nextRetryAt: clock.now() },
      });
      return { id: d.id };
    },
  };
}
