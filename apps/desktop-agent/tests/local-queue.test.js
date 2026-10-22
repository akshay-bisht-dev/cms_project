import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tempQueue } from './fakes.js';

const meta = (capturedAt) => ({ clientCaptureId: randomUUID(), capturedAt, policyVersionId: randomUUID(), sha256: 'x', mimeType: 'image/jpeg', width: 10, height: 10 });

describe('local queue', () => {
  it('stores items encrypted and returns them oldest first', async () => {
    const { queue, dir } = await tempQueue();
    const secret = Buffer.from('SECRET-SCREEN-CONTENT');
    await queue.add('capture', meta('2026-10-21T10:05:00Z'), secret);
    await queue.add('capture', meta('2026-10-21T10:00:00Z'), Buffer.from('older'));
    const files = await readdir(dir);
    for (const f of files) expect((await readFile(path.join(dir, f))).includes(secret)).toBe(false);
    const [first, second] = await queue.list();
    expect((await queue.read(first.name)).bytes.toString()).toBe('older');
    const item = await queue.read(second.name);
    expect(item).toMatchObject({ kind: 'capture', meta: { capturedAt: '2026-10-21T10:05:00Z' } });
    expect(item.bytes.equals(secret)).toBe(true);
  });

  it('detects tampering', async () => {
    const { queue, dir } = await tempQueue();
    const name = await queue.add('capture', meta('2026-10-21T10:00:00Z'), Buffer.from('image'));
    const file = path.join(dir, name);
    const blob = await readFile(file);
    blob[blob.length - 1] ^= 0xff;
    await writeFile(file, blob);
    await expect(queue.read(name)).rejects.toThrow();
  });

  it('evicts expired and over-quota items oldest first and reports them', async () => {
    const { queue } = await tempQueue({ maxBytes: 3000, maxAgeMs: 3600_000 });
    const now = Date.parse('2026-10-21T12:00:00Z');
    const old = meta('2026-10-21T10:00:00Z');
    await queue.add('capture', old, Buffer.alloc(10));
    const a = meta('2026-10-21T11:30:00Z');
    await queue.add('capture', a, Buffer.alloc(2000));
    await queue.add('capture', meta('2026-10-21T11:40:00Z'), Buffer.alloc(2000));
    const dropped = await queue.enforceLimits(now);
    expect(dropped.map((d) => [d.clientCaptureId, d.reason])).toEqual([
      [old.clientCaptureId, 'EXPIRED'],
      [a.clientCaptureId, 'DROPPED_QUEUE_FULL'],
    ]);
    expect((await queue.stats()).depth).toBe(1);
  });

  it('refuses a weak key and clears everything on disconnect', async () => {
    const { queue } = await tempQueue();
    await queue.add('failure', meta('2026-10-21T10:00:00Z'));
    await queue.clear();
    expect(await queue.stats()).toEqual({ depth: 0, bytes: 0 });
    const { createLocalQueue } = await import('../src/local-queue.js');
    expect(() => createLocalQueue({ dir: '/tmp/x', key: Buffer.alloc(16) })).toThrow(/32 bytes/);
  });
});
