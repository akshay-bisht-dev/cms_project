import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFixedClock } from '../../src/services/clock.js';
import {
  challengeExpired,
  challengeMessage,
  createAgentTokens,
  createChallenge,
  generatePairingCode,
  normalizePairingCode,
  parsePublicKey,
  timestampFresh,
  verifyAgentSignature,
} from '../../src/modules/monitoring/agent-auth.js';
import { noticeHashFor, DEFAULT_POLICY_SETTINGS } from '../../src/modules/monitoring/policy.js';

const clock = createFixedClock('2026-10-21T10:00:00Z');

describe('pairing codes', () => {
  it('are 8 unambiguous characters and normalize what people type', () => {
    for (let i = 0; i < 50; i += 1) expect(generatePairingCode()).toMatch(/^[A-HJ-KMNP-Z2-9]{8}$/);
    expect(normalizePairingCode('abcd-efgh ')).toBe('ABCDEFGH');
  });
});

describe('device keys and challenges', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

  it('accepts only raw 32-byte Ed25519 keys', () => {
    expect(() => parsePublicKey(raw)).not.toThrow();
    expect(() => parsePublicKey(Buffer.alloc(31).toString('base64'))).toThrow();
    expect(() => parsePublicKey('%%%')).toThrow();
  });

  it('verifies signatures over the exact challenge message', () => {
    const msg = challengeMessage({ agentId: 'a', nonce: 'n', ts: 1 });
    const sig = sign(null, msg, privateKey).toString('base64');
    expect(verifyAgentSignature(raw, msg, sig)).toBe(true);
    expect(verifyAgentSignature(raw, challengeMessage({ agentId: 'a', nonce: 'n', ts: 2 }), sig)).toBe(false);
    expect(verifyAgentSignature(raw, msg, 'short')).toBe(false);
  });

  it('expires challenges after 60 s and refuses skewed timestamps', () => {
    const c = createChallenge(clock);
    expect(challengeExpired(c.nonce, clock)).toBe(false);
    expect(challengeExpired(c.nonce, createFixedClock('2026-10-21T10:01:01Z'))).toBe(true);
    expect(challengeExpired('garbage', clock)).toBe(true);
    const now = clock.now().getTime() / 1000;
    expect(timestampFresh(now + 60, clock)).toBe(true);
    expect(timestampFresh(now - 600, clock)).toBe(false);
  });
});

describe('agent tokens', () => {
  const tokens = createAgentTokens('x'.repeat(48), clock);

  it('round-trips and rejects tampering, wrong secrets and expiry', () => {
    const { accessToken } = tokens.issue({ agentId: 'agent-1', organizationId: 'org-1', userId: 'user-1' });
    expect(tokens.verify(accessToken)).toMatchObject({ aud: 'agent', sub: 'agent-1', org: 'org-1', mem: 'user-1' });

    const [h, p, s] = accessToken.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'agent-2' })).toString('base64url');
    expect(() => tokens.verify(`${h}.${forged}.${s}`)).toThrow(/invalid/);
    expect(() => createAgentTokens('y'.repeat(48), clock).verify(accessToken)).toThrow(/invalid/);
    expect(() => createAgentTokens('x'.repeat(48), createFixedClock('2026-10-21T10:15:01Z')).verify(accessToken)).toThrow(/expired/);
  });
});

describe('notice hash', () => {
  it('changes when the text or a material setting changes, not when excluded apps are reordered', () => {
    const base = { ...DEFAULT_POLICY_SETTINGS, excludedApps: ['a', 'b'] };
    expect(noticeHashFor(base)).toBe(noticeHashFor({ ...base, excludedApps: ['b', 'a'] }));
    expect(noticeHashFor(base)).not.toBe(noticeHashFor({ ...base, intervalS: 300 }));
    expect(noticeHashFor(base)).not.toBe(noticeHashFor({ ...base, noticeText: `${base.noticeText} More.` }));
  });
});
