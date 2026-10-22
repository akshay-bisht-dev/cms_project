import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MAX_AGE_MS = 72 * 3600 * 1000;
const EXT = '.q';

/** AES-256-GCM: file = iv (12) | tag (16) | ciphertext. Tampering makes decryption fail. */
export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key, blob) {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

function pack(meta, bytes = Buffer.alloc(0)) {
  const header = Buffer.from(JSON.stringify(meta), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, bytes]);
}

function unpack(buf) {
  const len = buf.readUInt32BE(0);
  return { meta: JSON.parse(buf.subarray(4, 4 + len).toString('utf8')), bytes: buf.subarray(4 + len) };
}

/**
 * Encrypted on-disk queue of captures waiting to upload (and of failure reports). Bounded by
 * size and age; anything evicted is returned so the agent can report it to the server as
 * DROPPED_QUEUE_FULL / EXPIRED, keeping coverage reports honest.
 * File names are `<capturedAtMs>-<id>.q`, so lexical order is oldest first.
 */
export function createLocalQueue({ dir, key, maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Queue key must be 32 bytes');
  const ready = mkdir(dir, { recursive: true, mode: 0o700 });

  async function entries() {
    await ready;
    const names = (await readdir(dir)).filter((n) => n.endsWith(EXT)).sort();
    const out = [];
    for (const name of names) {
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (s) out.push({ name, size: s.size, capturedAtMs: Number(name.split('-')[0]) });
    }
    return out;
  }

  return {
    /** kind: 'capture' (meta + image bytes) or 'failure' (meta only). */
    async add(kind, meta, bytes) {
      await ready;
      const name = `${String(Date.parse(meta.capturedAt)).padStart(15, '0')}-${meta.clientCaptureId}${EXT}`;
      const tmp = path.join(dir, `${name}.tmp`);
      await writeFile(tmp, encrypt(key, pack({ kind, ...meta }, bytes)), { mode: 0o600 });
      await rename(tmp, path.join(dir, name)); // atomic: a crash never leaves a half-written item
      return name;
    },

    async list() {
      return entries();
    },

    async read(name) {
      const { meta, bytes } = unpack(decrypt(key, await readFile(path.join(dir, name))));
      return { name, kind: meta.kind, meta, bytes };
    },

    async remove(name) {
      await rm(path.join(dir, name), { force: true });
    },

    /** Removes expired and over-quota items (oldest first); returns their metadata. */
    async enforceLimits(nowMs) {
      const all = await entries();
      const dropped = [];
      let total = all.reduce((sum, e) => sum + e.size, 0);
      for (const e of all) {
        const expired = nowMs - e.capturedAtMs > maxAgeMs;
        if (!expired && total <= maxBytes) continue;
        let meta = null;
        try {
          meta = (await this.read(e.name)).meta;
        } catch {
          // unreadable (e.g. key rotated): drop without a report
        }
        await this.remove(e.name);
        total -= e.size;
        if (meta?.kind === 'capture') dropped.push({ ...meta, reason: expired ? 'EXPIRED' : 'DROPPED_QUEUE_FULL' });
      }
      return dropped;
    },

    async stats() {
      const all = await entries();
      return { depth: all.length, bytes: all.reduce((sum, e) => sum + e.size, 0) };
    },

    async clear() {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
  };
}
