import sharp from 'sharp';
import { sha256 } from '../../services/crypto.js';
import { MAX_DIMENSION, tmpKeyFor } from './monitoring.service.js';
import { markStatsDirty } from '../activity/activity.js';

const FULL_MAX_WIDTH = 1920;
const THUMB_WIDTH = 320;
const RETENTION_BATCH = 500;
const STALE_UPLOAD_MS = 24 * 3600 * 1000;
const DECODABLE_FORMATS = new Set(['webp', 'png', 'jpeg']);

function finalKey(prefix, shot) {
  const iso = shot.capturedAt.toISOString();
  return `${prefix}/${shot.organizationId}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${shot.id}.webp`;
}

async function reject(prisma, storage, shot, failureCode) {
  await storage.remove({ bucket: storage.buckets.captures, key: tmpKeyFor(shot) }).catch(() => {});
  await prisma.screenshot.updateMany({ where: { organizationId: shot.organizationId, id: shot.id, status: 'UPLOADED' }, data: { status: 'REJECTED', failureCode } });
  await markStatsDirty(prisma, shot.organizationId, shot.userId, [shot.capturedAt]);
  return { status: 'REJECTED', failureCode };
}

/**
 * screenshot.process: validates the uploaded bytes and produces the stored variants.
 * The upload is untrusted: it is hashed against the declared checksum, decoded with sharp (which
 * rejects anything that is not a real image), re-encoded to WebP without metadata, and only then
 * moved out of tmp/. Idempotent: rows that are no longer UPLOADED are skipped.
 */
export async function processScreenshot({ prisma, storage, clock, logger }, { organizationId, screenshotId }) {
  const shot = await prisma.screenshot.findFirst({ where: { organizationId, id: screenshotId } });
  if (!shot || shot.status !== 'UPLOADED') return { skipped: true };

  let input;
  try {
    input = await storage.getObject({ bucket: storage.buckets.captures, key: tmpKeyFor(shot) });
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      await prisma.screenshot.updateMany({ where: { organizationId, id: shot.id, status: 'UPLOADED' }, data: { status: 'FAILED', failureCode: 'OBJECT_MISSING' } });
      await markStatsDirty(prisma, organizationId, shot.userId, [shot.capturedAt]);
      return { status: 'FAILED', failureCode: 'OBJECT_MISSING' };
    }
    throw err; // transient storage error: let the queue retry
  }

  if (sha256(input) !== shot.sha256) return reject(prisma, storage, shot, 'CHECKSUM_MISMATCH');

  let full;
  let thumb;
  try {
    const image = sharp(input, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION, failOn: 'error' });
    const meta = await image.metadata();
    if (!DECODABLE_FORMATS.has(meta.format) || !meta.width || !meta.height || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
      return reject(prisma, storage, shot, 'INVALID_IMAGE');
    }
    // sharp drops EXIF/XMP/ICC metadata unless asked to keep it.
    full = await sharp(input, { failOn: 'error' }).resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });
    thumb = await sharp(input, { failOn: 'error' }).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
  } catch (err) {
    logger?.warn({ screenshotId, err: err.message }, 'screenshot could not be decoded');
    return reject(prisma, storage, shot, 'INVALID_IMAGE');
  }

  const storageKey = finalKey('captures', shot);
  const thumbKey = finalKey('thumbs', shot);
  await storage.putObject({ bucket: storage.buckets.captures, key: storageKey, body: full.data, contentType: 'image/webp' });
  await storage.putObject({ bucket: storage.buckets.captures, key: thumbKey, body: thumb, contentType: 'image/webp' });

  const [version, orgPolicy] = await Promise.all([
    prisma.monitoringPolicyVersion.findFirst({ where: { organizationId, id: shot.policyVersionId } }),
    prisma.capturePolicy.findFirst({ where: { organizationId, scopeLevel: 'ORG' } }),
  ]);
  const orgVersion = orgPolicy?.currentVersionId ? await prisma.monitoringPolicyVersion.findFirst({ where: { organizationId, id: orgPolicy.currentVersionId } }) : null;
  const retentionDays = Math.min(version.retentionDays, orgVersion?.retentionDays ?? version.retentionDays);

  const { count } = await prisma.screenshot.updateMany({
    where: { organizationId, id: shot.id, status: 'UPLOADED' },
    data: {
      status: 'READY',
      storageKey,
      thumbKey,
      mimeType: 'image/webp',
      width: full.info.width,
      height: full.info.height,
      sizeBytes: full.data.length,
      retentionExpiresAt: new Date(shot.capturedAt.getTime() + retentionDays * 86400_000),
    },
  });
  if (count === 0) {
    // Deleted or changed while processing: do not leave orphaned objects behind.
    await storage.remove({ bucket: storage.buckets.captures, key: storageKey }).catch(() => {});
    await storage.remove({ bucket: storage.buckets.captures, key: thumbKey }).catch(() => {});
    return { skipped: true };
  }
  await storage.remove({ bucket: storage.buckets.captures, key: tmpKeyFor(shot) }).catch(() => {});
  await markStatsDirty(prisma, organizationId, shot.userId, [shot.capturedAt]);
  logger?.debug?.({ screenshotId, at: clock.now() }, 'screenshot ready');
  return { status: 'READY' };
}

/**
 * Daily retention: deletes expired captures that are not under legal hold. Objects are removed
 * first; the row is marked DELETED (with a deletion log) only after that succeeded, so a crash
 * leaves the row to be retried rather than an orphaned object.
 */
export async function purgeExpiredScreenshots({ prisma, storage, clock, logger }) {
  let deleted = 0;
  for (;;) {
    const now = clock.now();
    const batch = await prisma.unscoped.screenshot.findMany({
      where: { status: 'READY', retentionExpiresAt: { lt: now }, legalHold: false },
      orderBy: { retentionExpiresAt: 'asc' },
      take: RETENTION_BATCH,
    });
    if (batch.length === 0) break;
    let progressed = 0;
    for (const shot of batch) {
      try {
        // Re-check just before deleting: a hold may have been placed since the batch was read.
        const fresh = await prisma.screenshot.findFirst({ where: { organizationId: shot.organizationId, id: shot.id } });
        if (!fresh || fresh.legalHold || fresh.status !== 'READY') continue;
        for (const key of [fresh.storageKey, fresh.thumbKey]) if (key) await storage.remove({ bucket: storage.buckets.captures, key });
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.screenshot.updateMany({
            where: { organizationId: shot.organizationId, id: shot.id, status: 'READY', legalHold: false },
            data: { status: 'DELETED', storageKey: null, thumbKey: null, deletedAt: now },
          });
          if (count) {
            await tx.screenshotDeletionLog.create({ data: { organizationId: shot.organizationId, screenshotId: shot.id, userId: shot.userId, capturedAt: shot.capturedAt, reason: 'RETENTION', createdAt: now } });
          }
        });
        deleted += 1;
        progressed += 1;
      } catch (err) {
        logger?.error({ screenshotId: shot.id, err: err.message }, 'retention delete failed; will retry');
      }
    }
    if (progressed === 0 || batch.length < RETENTION_BATCH) break;
  }
  return { deleted };
}

/** Marks uploads that never completed as FAILED (UPLOAD_TIMEOUT) and removes any partial object. */
export async function sweepStaleUploads({ prisma, storage, clock }) {
  const cutoff = new Date(clock.now().getTime() - STALE_UPLOAD_MS);
  const stale = await prisma.unscoped.screenshot.findMany({ where: { status: 'PENDING_UPLOAD', createdAt: { lt: cutoff } }, take: 1000 });
  for (const shot of stale) {
    await storage.remove({ bucket: storage.buckets.captures, key: tmpKeyFor(shot) }).catch(() => {});
    await prisma.screenshot.updateMany({ where: { organizationId: shot.organizationId, id: shot.id, status: 'PENDING_UPLOAD' }, data: { status: 'FAILED', failureCode: 'UPLOAD_TIMEOUT' } });
    await markStatsDirty(prisma, shot.organizationId, shot.userId, [shot.capturedAt]);
  }
  return { failed: stale.length };
}
