import { createHmac, createPublicKey, randomBytes, randomInt, verify } from 'node:crypto';
import { ERROR_CODES } from '@orbit/shared-constants';
import { UnauthenticatedError, ValidationError } from '../../utils/errors.js';
import { hmac, safeEqual, sha256 } from '../../services/crypto.js';

export const PAIRING_TTL_S = 300;
export const CHALLENGE_TTL_S = 60;
export const AGENT_TOKEN_TTL_S = 15 * 60;
/** How far the agent's signed timestamp may drift from the server clock. */
const MAX_CLOCK_SKEW_S = 120;

// Unambiguous characters only (no 0/O, 1/I/L), so codes survive being read aloud or retyped.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function generatePairingCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/** Codes are compared case-insensitively and with any separator the user typed removed. */
export function normalizePairingCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Parses a base64 raw Ed25519 public key; throws a validation error for anything else. */
export function parsePublicKey(publicKey) {
  const raw = Buffer.from(String(publicKey), 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) {
    throw new ValidationError([{ path: 'body.publicKey', message: 'Expected a base64-encoded 32-byte Ed25519 public key' }]);
  }
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The exact bytes an agent signs to obtain a token. Shared with the desktop agent. */
export function challengeMessage({ agentId, nonce, ts }) {
  return Buffer.from(`orbit-agent-token\n${agentId}\n${nonce}\n${ts}`, 'utf8');
}

export function verifyAgentSignature(publicKey, message, signature) {
  const sig = Buffer.from(String(signature), 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, message, parsePublicKey(publicKey), sig);
  } catch {
    return false;
  }
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Agent access tokens are compact HS256 JWTs (aud=agent). They are short-lived and carry no
 * refresh token: the device key is the long-term credential, and every request still checks
 * that the agent is ACTIVE, so revocation takes effect immediately.
 */
export function createAgentTokens(secret, clock) {
  const key = hmac(secret, 'agent-token-key');
  const sign = (input) => createHmac('sha256', key).update(input).digest('base64url');

  return {
    issue({ agentId, organizationId, userId }) {
      const iat = Math.floor(clock.now().getTime() / 1000);
      const exp = iat + AGENT_TOKEN_TTL_S;
      const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ aud: 'agent', sub: agentId, org: organizationId, mem: userId, iat, exp })}`;
      return { accessToken: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000).toISOString() };
    },

    /** Returns the claims, or throws 401 INVALID_TOKEN. */
    verify(token) {
      const invalid = new UnauthenticatedError('The agent token is invalid or has expired', ERROR_CODES.INVALID_TOKEN);
      const parts = String(token).split('.');
      if (parts.length !== 3 || !safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`))) throw invalid;
      let claims;
      try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        throw invalid;
      }
      if (claims.aud !== 'agent' || typeof claims.exp !== 'number' || claims.exp * 1000 <= clock.now().getTime()) throw invalid;
      return claims;
    },
  };
}

/** One-time challenge: random, with its expiry inside. Only its hash is stored on the agent row. */
export function createChallenge(clock) {
  const expiresAt = new Date(clock.now().getTime() + CHALLENGE_TTL_S * 1000);
  const nonce = `${randomBytes(24).toString('base64url')}.${expiresAt.getTime()}`;
  return { nonce, nonceHash: sha256(nonce), expiresAt };
}

export function challengeExpired(nonce, clock) {
  const expiresMs = Number(String(nonce).split('.')[1]);
  return !Number.isFinite(expiresMs) || expiresMs <= clock.now().getTime();
}

export function timestampFresh(ts, clock) {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && Math.abs(clock.now().getTime() / 1000 - seconds) <= MAX_CLOCK_SKEW_S;
}
