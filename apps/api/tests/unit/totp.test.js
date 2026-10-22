import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, timeStep, verifyTotp } from '../../src/services/totp.js';

// RFC 6238 Appendix B (SHA-1): secret "12345678901234567890", 8 digits.
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, timeStep(new Date(seconds * 1000)), 8)).toBe(expected);
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('any random secret!');
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('accepts the current and adjacent steps only, and reports the matched step', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = new Date(1_700_000_000_000);
    const step = timeStep(now);
    const code = (s) => hotp(RFC_SECRET, s);
    expect(verifyTotp(secret, code(step), now)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', accountName: 'a@b.test', issuer: 'Orbit' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Orbit%3Aa%40b\.test\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
  });
});
