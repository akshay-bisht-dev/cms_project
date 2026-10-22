import { Algorithm, hash, verify } from '@node-rs/argon2';

// OWASP Argon2id baseline. Parameters are embedded in each hash, so they can be raised later
// and old hashes upgraded on the next successful login (see needsRehash).
const PARAMS = Object.freeze({ algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

// Verifying against this hash when a user does not exist keeps response times uniform.
let dummyHashPromise;

export function hashPassword(plain) {
  return hash(plain, PARAMS);
}

export async function verifyPassword(passwordHash, plain) {
  if (!passwordHash) {
    dummyHashPromise ??= hash('dummy-password-for-timing', PARAMS);
    await verify(await dummyHashPromise, plain).catch(() => false);
    return false;
  }
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(passwordHash) {
  return !passwordHash.startsWith(`$argon2id$v=19$m=${PARAMS.memoryCost},t=${PARAMS.timeCost},p=${PARAMS.parallelism}$`);
}
