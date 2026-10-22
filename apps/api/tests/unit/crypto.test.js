import { describe, expect, it } from 'vitest';
import { createFieldCipher, safeEqual } from '../../src/services/crypto.js';
import { createCursorCodec } from '../../src/utils/cursor.js';

const key = (n) => Buffer.alloc(32, n).toString('base64');

describe('field cipher', () => {
  it('encrypts with a random IV and decrypts', () => {
    const cipher = createFieldCipher(`k1:${key(1)}`);
    const a = cipher.encrypt('alice@personal.test');
    const b = cipher.encrypt('alice@personal.test');
    expect(a).not.toBe(b);
    expect(a).not.toContain('alice');
    expect(cipher.decrypt(a)).toBe('alice@personal.test');
    expect(cipher.decryptJson(cipher.encryptJson({ city: 'Pune' }))).toEqual({ city: 'Pune' });
    expect(cipher.encrypt(null)).toBeNull();
  });

  it('decrypts values written with an older key after rotation', () => {
    const old = createFieldCipher(`k1:${key(1)}`);
    const rotated = createFieldCipher(`k2:${key(2)},k1:${key(1)}`);
    const legacy = old.encrypt('secret');
    expect(rotated.decrypt(legacy)).toBe('secret');
    expect(rotated.encrypt('x').split('.')[1]).toBe('k2');
  });

  it('detects tampering', () => {
    const cipher = createFieldCipher(`k1:${key(1)}`);
    const parts = cipher.encrypt('payload').split('.');
    parts[4] = Buffer.from('forged').toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'))).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => createFieldCipher(`k1:${Buffer.alloc(16).toString('base64')}`)).toThrow(/32 bytes/);
  });
});

describe('cursor codec', () => {
  const codec = createCursorCodec('s'.repeat(32));
  const detailOf = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.details?.[0]?.message;
    }
    return null;
  };

  it('round-trips and binds to the sort', () => {
    const cursor = codec.encode({ sort: 'name', v: 'Alice', id: 'x' });
    expect(codec.decode(cursor, 'name')).toEqual({ sort: 'name', v: 'Alice', id: 'x' });
    expect(detailOf(() => codec.decode(cursor, '-name'))).toMatch(/does not match/);
  });

  it('rejects forged cursors', () => {
    const [, signature] = codec.encode({ sort: 'name', v: 'A', id: 'x' }).split('.');
    const forged = `${Buffer.from(JSON.stringify({ sort: 'name', v: 'Z', id: 'y' })).toString('base64url')}.${signature}`;
    expect(detailOf(() => codec.decode(forged, 'name'))).toBe('Invalid cursor');
    expect(detailOf(() => codec.decode('garbage', 'name'))).toBe('Invalid cursor');
  });
});

describe('safeEqual', () => {
  it('compares strings of different lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'x')).toBe(false);
  });
});

describe('outbox key fitting', async () => {
  const { fitKey } = await import('../../src/services/outbox.js');
  it('keeps short keys and digests long ones to a fixed length', () => {
    expect(fitKey('short-key')).toBe('short-key');
    const long = 'x'.repeat(300);
    expect(fitKey(long)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fitKey(long)).toBe(fitKey(long));
    expect(fitKey(long)).not.toBe(fitKey(`${long}y`));
  });
});
