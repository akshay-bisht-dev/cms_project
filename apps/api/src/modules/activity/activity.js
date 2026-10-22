import { Prisma } from '@prisma/client';
import { ACTIVITY_TYPES } from '@orbit/shared-constants';

const utcDate = (instant) => new Date(instant).toISOString().slice(0, 10);

/**
 * Marks the UTC dates touched by `instants` as needing a stats rebuild. Idempotent; call it in
 * the same transaction as the change so a rollback leaves nothing behind.
 */
export async function markStatsDirty(db, organizationId, userId, instants) {
  const dates = [...new Set(instants.filter(Boolean).map(utcDate))];
  if (!dates.length || !organizationId || !userId) return;
  const values = dates.map((d) => Prisma.sql`(${organizationId}, ${userId}, ${d}, NOW(3))`);
  await db.$executeRaw`
    INSERT INTO stats_dirty_days (organization_id, user_id, date, marked_at)
    VALUES ${Prisma.join(values)}
    ON DUPLICATE KEY UPDATE marked_at = NOW(3)`;
}

/**
 * Appends an activity event (FR-ACT-1) and marks the affected days dirty. `affects` lists other
 * instants whose day totals change (e.g. the old and new times of an edited entry).
 * Pass the transaction client so the event commits with the change it describes.
 */
export async function recordActivity(db, { organizationId, userId, type, occurredAt, subjectType = null, subjectId = null, projectId = null, durationS = null, metadata = null, affects = [] }) {
  if (!ACTIVITY_TYPES[type]) throw new Error(`Unknown activity type "${type}"`);
  await db.activityEvent.create({
    data: { organizationId, userId, type, occurredAt, subjectType, subjectId, projectId, durationS, metadata: metadata ?? undefined },
  });
  const end = durationS ? new Date(occurredAt.getTime() + durationS * 1000) : null;
  await markStatsDirty(db, organizationId, userId, [occurredAt, end, ...affects]);
}
