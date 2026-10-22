import { sha256 } from './crypto.js';

const KEY_COLUMN_LENGTH = 191;

/** Keys longer than the indexed column are stored as a digest: still unique, always the right length. */
export function fitKey(key) {
  return key.length <= KEY_COLUMN_LENGTH ? key : `sha256:${sha256(key)}`;
}

/**
 * Adds an event to the transactional outbox. Call with the same transaction client as the
 * state change; the worker relays committed events to queues (at-least-once delivery).
 * `dedupeKey` makes enqueueing idempotent: a duplicate key is silently ignored.
 */
export async function enqueueOutbox(db, { type, payload, dedupeKey, organizationId = null, availableAt }) {
  try {
    await db.outboxEvent.create({ data: { type, payload, dedupeKey: fitKey(dedupeKey), organizationId, availableAt } });
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
  }
}
