import { backoffMs } from './scheduler.js';

/**
 * Drains the local queue oldest-first: presign → PUT to storage → complete, then deletes the local
 * copy. Every step is idempotent on the server (keyed by clientCaptureId), so a crash or retry at
 * any point is safe. Permanent refusals (e.g. captured outside a work session) are dropped;
 * transient failures stop the drain and back off.
 */
export function createUploader({ api, queue, refreshToken, random = Math.random, log = () => {} }) {
  let attempt = 0;

  async function sendOne(item) {
    if (item.kind === 'failure') {
      await api.fail({ clientCaptureId: item.meta.clientCaptureId, capturedAt: item.meta.capturedAt, policyVersionId: item.meta.policyVersionId, code: item.meta.code });
      return;
    }
    const { meta, bytes } = item;
    const presigned = await api.presign({
      clientCaptureId: meta.clientCaptureId,
      capturedAt: meta.capturedAt,
      policyVersionId: meta.policyVersionId,
      sha256: meta.sha256,
      sizeBytes: bytes.length,
      mimeType: meta.mimeType,
      width: meta.width,
      height: meta.height,
    });
    // upload is null when the server already has the bytes (a retry after a lost response).
    if (presigned.upload) await api.put(presigned.upload, bytes);
    if (presigned.status === 'PENDING_UPLOAD') await api.complete(presigned.screenshotId);
  }

  /** One 401 per drain is answered by refreshing the token and retrying once. */
  async function sendWithRefresh(item, run) {
    try {
      await sendOne(item);
    } catch (err) {
      if (err.status !== 401 || err.code === 'AGENT_REVOKED' || run.refreshed) throw err;
      run.refreshed = true;
      await refreshToken();
      await sendOne(item);
    }
  }

  return {
    /** Returns { sent, dropped, retryInMs, error } — retryInMs is null when the queue was emptied. */
    async drain({ max = 50 } = {}) {
      let sent = 0;
      let dropped = 0;
      const run = { refreshed: false };
      const entries = await queue.list();
      for (const entry of entries.slice(0, max)) {
        let item;
        try {
          item = await queue.read(entry.name);
        } catch {
          await queue.remove(entry.name); // corrupt or undecryptable: nothing can be done with it
          dropped += 1;
          continue;
        }
        try {
          await sendWithRefresh(item, run);
          await queue.remove(entry.name);
          sent += 1;
          attempt = 0;
        } catch (err) {
          if (err.code === 'AGENT_REVOKED') throw err;
          if (err.permanent) {
            log('warn', `Dropped a queued capture: ${err.code} ${err.message}`);
            await queue.remove(entry.name);
            dropped += 1;
            continue;
          }
          attempt += 1;
          return { sent, dropped, retryInMs: backoffMs(attempt, random), error: err.message };
        }
      }
      return { sent, dropped, retryInMs: entries.length > max ? 0 : null, error: null };
    },
  };
}
