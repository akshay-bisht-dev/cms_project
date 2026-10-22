import { createHmac, randomBytes } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) — the parameters every authenticator app supports.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HOTP value for a counter (RFC 4226). `key` is a Buffer. */
export function hotp(key, counter, digits = DIGITS, algorithm = 'sha1') {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(date) {
  return Math.floor(date.getTime() / 1000 / STEP_SECONDS);
}

/**
 * Verifies a code within ±1 step of clock drift. Returns the matched step (so callers can
 * reject replays of a step already used) or null.
 */
export function verifyTotp(secretBase32, code, now, { window = 1 } = {}) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const key = base32Decode(secretBase32);
  const current = timeStep(now);
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(key, current + offset) === code) return current + offset;
  }
  return null;
}

export function otpauthUri({ secret, accountName, issuer }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
