import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url: used for session, CSRF, invitation, and email tokens. */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * AES-256-GCM field encryption with key rotation. Ciphertext format:
 *   v1.<kid>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * The first configured key encrypts; any configured key can decrypt (looked up by kid).
 */
export function createFieldCipher(keysSpec) {
  const keys = new Map();
  let activeKid;
  for (const pair of keysSpec.split(',')) {
    const [kid, b64] = pair.split(':');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Field encryption key "${kid}" must be 32 bytes`);
    keys.set(kid, key);
    activeKid ??= kid;
  }

  return {
    encrypt(plaintext) {
      if (plaintext === null || plaintext === undefined) return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(activeKid), iv);
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', activeKid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    decrypt(payload) {
      if (payload === null || payload === undefined) return null;
      const [version, kid, iv, tag, data] = String(payload).split('.');
      const key = keys.get(kid);
      if (version !== 'v1' || !key) throw new Error('Unreadable encrypted value (unknown key or format)');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
    encryptJson(value) {
      return value === null || value === undefined ? null : this.encrypt(JSON.stringify(value));
    },
    decryptJson(payload) {
      const text = this.decrypt(payload);
      return text === null ? null : JSON.parse(text);
    },
  };
}
