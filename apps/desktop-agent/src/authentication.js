import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

/** Must match the API's challengeMessage (apps/api/src/modules/monitoring/agent-auth.js). */
export function challengeMessage({ agentId, nonce, ts }) {
  return Buffer.from(`orbit-agent-token\n${agentId}\n${nonce}\n${ts}`, 'utf8');
}

/**
 * The device key pair. The private key never leaves this machine: it is kept encrypted with the
 * OS keychain (via `secrets`, e.g. Electron safeStorage) and only used to sign challenges.
 * There is no refresh token; the signature is the credential.
 */
export function createDeviceKeys({ secrets }) {
  let cached = null;

  async function privateKey() {
    if (cached) return cached;
    const pem = await secrets.read('device-key');
    if (!pem) return null;
    cached = createPrivateKey(pem);
    return cached;
  }

  return {
    /** Creates a fresh key pair and returns the raw public key (base64) for registration. */
    async generate() {
      const { publicKey, privateKey: key } = generateKeyPairSync('ed25519');
      await secrets.write('device-key', key.export({ format: 'pem', type: 'pkcs8' }));
      cached = key;
      return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    },

    async signChallenge({ agentId, nonce, ts }) {
      const key = await privateKey();
      if (!key) throw new Error('This device is not paired');
      return sign(null, challengeMessage({ agentId, nonce, ts }), key).toString('base64');
    },

    async clear() {
      cached = null;
      await secrets.remove('device-key');
    },
  };
}
