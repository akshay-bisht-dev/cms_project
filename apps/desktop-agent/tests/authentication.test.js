import { describe, expect, it } from 'vitest';
import { challengeMessage as agentMessage } from '../src/authentication.js';
// Contract test: the agent must sign exactly what the API verifies.
import { challengeMessage as serverMessage, verifyAgentSignature } from '../../api/src/modules/monitoring/agent-auth.js';
import { keysFor, memorySecrets } from './fakes.js';

describe('device keys', () => {
  it('signs challenges the server accepts, and only with the stored key', async () => {
    const secrets = memorySecrets();
    const keys = keysFor(secrets);
    const publicKey = await keys.generate();
    const challenge = { agentId: '0192f2b0-7c1e-7cc2-9d1a-3b8f0d6a1e11', nonce: 'abc.123', ts: 1790000000 };
    expect(agentMessage(challenge).equals(serverMessage(challenge))).toBe(true);
    const signature = await keys.signChallenge(challenge);
    expect(verifyAgentSignature(publicKey, serverMessage(challenge), signature)).toBe(true);
    expect(verifyAgentSignature(publicKey, serverMessage({ ...challenge, ts: challenge.ts + 1 }), signature)).toBe(false);

    // The private key is held only in the secret store (OS keychain in the app).
    expect(secrets.map.get('device-key')).toMatch(/BEGIN PRIVATE KEY/);
    await keys.clear();
    await expect(keys.signChallenge(challenge)).rejects.toThrow(/not paired/);
  });
});
