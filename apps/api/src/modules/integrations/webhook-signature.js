import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (FR-INT-1). Each delivery carries
 *   X-Orbit-Timestamp: unix seconds
 *   X-Orbit-Delivery:  unique delivery id (the nonce)
 *   X-Orbit-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<delivery id>.<raw body>")>
 * Binding the timestamp and delivery id into the signature means neither can be altered, so a
 * receiver that rejects old timestamps and already-seen delivery ids is safe from replays.
 */
export function signPayload({ secret, timestamp, deliveryId, body }) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
}

export class WebhookVerificationError extends Error {}

/**
 * Receiver-side verification (also used by our tests and documented for integrators).
 * `seen` remembers delivery ids for at least the tolerance window: { has(id), add(id) }. Retries reuse
 * the delivery id, so pass `seen` only if a failure after this point is answered 2xx anyway; otherwise
 * check `seen` here and add the id once the event is handled (docs/integrations.md).
 */
export function verifyWebhook({ secret, headers, body, now = Date.now(), toleranceS = 300, seen }) {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];
  const timestamp = Number(get('X-Orbit-Timestamp'));
  const deliveryId = get('X-Orbit-Delivery');
  const signature = String(get('X-Orbit-Signature') ?? '');
  if (!Number.isInteger(timestamp) || !deliveryId) throw new WebhookVerificationError('Missing signature headers');
  if (Math.abs(now / 1000 - timestamp) > toleranceS) throw new WebhookVerificationError('Timestamp outside the tolerance window');
  const expected = Buffer.from(signPayload({ secret, timestamp, deliveryId, body }));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new WebhookVerificationError('Signature mismatch');
  if (seen) {
    if (seen.has(deliveryId)) throw new WebhookVerificationError('Delivery already processed (replay)');
    seen.add(deliveryId);
  }
  return JSON.parse(body);
}
