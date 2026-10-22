import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent.js';
import { verifyAgentSignature, challengeMessage } from '../../api/src/modules/monitoring/agent-auth.js';
import { fail, fakeServer, keysFor, memorySecrets, memoryStore, ok, tempQueue } from './fakes.js';

const VERSION_ID = randomUUID();
const START = Date.parse('2026-10-21T10:00:00Z');

function permitAt(t, overrides = {}) {
  return {
    capture: true,
    reason: null,
    policyVersionId: VERSION_ID,
    intervalS: 600,
    blur: false,
    captureMode: 'ACTIVE_SCREEN',
    excludedApps: [],
    serverTime: new Date(t).toISOString(),
    permitExpiresAt: new Date(t + 120_000).toISOString(),
    organization: { id: 'org', name: 'Acme' },
    member: { name: 'Esha' },
    ...overrides,
  };
}

let t;
let state;
let env;

async function setup({ permit = {}, osPermission = 'granted', frontmost = null, routes = {}, idle = async () => 0 } = {}) {
  t = START;
  state = { permit, publicKey: null, tokens: 0, revoked: false, uploads: [] };
  const server = fakeServer({
    '/register': (body) => {
      state.publicKey = body.publicKey;
      return ok({ agentId: 'agent-1', accessToken: 'tok-0', expiresAt: new Date(t + 15 * 60_000).toISOString(), organization: { id: 'org', name: 'Acme' }, member: { name: 'Esha' } });
    },
    '/challenge': () => ok({ nonce: `nonce-${state.tokens}`, expiresAt: new Date(t + 60_000).toISOString() }),
    '/token': (body) => {
      const valid = verifyAgentSignature(state.publicKey, challengeMessage(body), body.signature);
      if (!valid) return fail(401, 'INVALID_TOKEN');
      state.tokens += 1;
      return ok({ accessToken: `tok-${state.tokens}`, expiresAt: new Date(t + 15 * 60_000).toISOString() });
    },
    '/heartbeat': (body) => {
      state.lastHeartbeat = body;
      if (state.revoked) return fail(401, 'AGENT_REVOKED');
      return ok(permitAt(t, state.permit));
    },
    '/uploads/presign': (body) => {
      state.presigned = body;
      return ok({ screenshotId: 'shot-1', status: 'PENDING_UPLOAD', upload: { url: 'https://storage.test/tmp/x', method: 'PUT', headers: { 'Content-Type': body.mimeType } } });
    },
    storage: (body) => {
      state.uploads.push(body);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    '/uploads/complete': () => ok({ screenshotId: 'shot-1', status: 'UPLOADED' }),
    '/idle': (body) => {
      state.idle = [...(state.idle ?? []), ...body.intervals];
      return ok({ recorded: body.intervals.length });
    },
    '/uploads/fail': (body) => {
      state.failed = [...(state.failed ?? []), body];
      return ok({ status: 'FAILED' });
    },
    ...routes,
  });
  const secrets = memorySecrets();
  const store = memoryStore();
  const { queue } = await tempQueue();
  const captured = [];
  const agent = createAgent({
    store,
    keys: keysFor(secrets),
    queue,
    fetchImpl: server.fetchImpl,
    now: () => t,
    random: () => 0.5,
    capturer: { capture: async ({ blur }) => [{ bytes: Buffer.from(`jpeg-bytes-blur-${blur}`), width: 1920, height: 1080, mimeType: 'image/jpeg' }] },
    permissions: { status: async () => osPermission },
    frontmostApp: async () => frontmost,
    idleSeconds: () => idle(),
    onCaptured: (c) => captured.push(c),
  });
  await agent.init();
  await agent.pair({ serverUrl: 'https://orbit.example.com', code: 'ABCD-EFGH', deviceName: 'Laptop', os: 'darwin' });
  env = { agent, server, secrets, store, queue, captured };
  return env;
}

beforeEach(() => {
  env = null;
});

/** Simulated time as the real loops run it: a tick every second, a heartbeat every minute. */
async function advance(ms, { tick = true } = {}) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    t += 1000;
    if ((t - START) % 60_000 === 0) await env.agent.heartbeat();
    if (tick) await env.agent.tick();
  }
}

describe('pairing and tokens', () => {
  it('registers with a public key only and keeps the private key in the secret store', async () => {
    const { server, secrets, store, agent } = await setup();
    const register = server.calls.find((c) => c.path === '/register');
    expect(register.body).toMatchObject({ pairingCode: 'ABCD-EFGH', deviceName: 'Laptop', os: 'darwin' });
    expect(JSON.stringify(register.body)).not.toMatch(/PRIVATE/);
    expect(secrets.map.get('device-key')).toMatch(/PRIVATE KEY/);
    expect(store.value).toEqual({ serverUrl: 'https://orbit.example.com', agentId: 'agent-1', deviceName: 'Laptop' });
    expect(agent.status()).toMatchObject({ paired: true, organization: { name: 'Acme' } });
  });

  it('refuses plain-http servers other than localhost', async () => {
    await setup();
    await expect(env.agent.pair({ serverUrl: 'http://orbit.example.com', code: 'X', deviceName: 'L', os: 'darwin' })).rejects.toThrow(/https/);
  });

  it('refreshes the token with a signed challenge before it expires', async () => {
    const { agent, server } = await setup();
    t += 14.5 * 60_000;
    await agent.heartbeat();
    expect(state.tokens).toBe(1);
    const heartbeat = server.calls.filter((c) => c.path === '/heartbeat').at(-1);
    expect(heartbeat.headers.Authorization).toBe('Bearer tok-1');
  });
});

describe('capture decisions', () => {
  it('captures at a random point in the interval while permitted, then uploads and deletes the local copy', async () => {
    const { agent, queue, server, captured } = await setup();
    expect(agent.status()).toMatchObject({ capturing: true, text: 'Capturing every 10 min while you work' });
    await advance(299_000);
    expect(captured).toHaveLength(0); // first capture is due at 50 % of the interval (random = 0.5)
    await advance(1000);
    expect(captured).toHaveLength(1);
    expect((await queue.stats()).depth).toBe(1);

    await agent.drain();
    expect(state.presigned).toMatchObject({ policyVersionId: VERSION_ID, mimeType: 'image/jpeg', width: 1920, capturedAt: new Date(t).toISOString() });
    expect(state.uploads[0].toString()).toBe('jpeg-bytes-blur-false');
    expect(server.calls.map((c) => c.path)).toContain('/uploads/complete');
    expect((await queue.stats()).depth).toBe(0);

    // Next capture ≈ one interval later (±20 %; random = 0.5 → exactly 600 s).
    await advance(599_000);
    expect(captured).toHaveLength(1);
    await advance(1000);
    expect(captured).toHaveLength(2);
  });

  it.each([
    ['ON_BREAK', 'Paused: you are on a break'],
    ['CLOCKED_OUT', 'Paused: you are clocked out'],
    ['CONSENT_REQUIRED', 'Paused: acknowledge the monitoring notice in Orbit'],
  ])('does not capture when the server says %s', async (reason, text) => {
    const { agent, captured } = await setup({ permit: { capture: false, reason } });
    await advance(3600_000);
    expect(captured).toHaveLength(0);
    expect(agent.status()).toMatchObject({ capturing: false, reason, text });
  });

  it('pauses on its own when the permit is not renewed (offline)', async () => {
    const { agent, captured } = await setup();
    t += 121_000;
    await agent.tick();
    expect(captured).toHaveLength(0);
    expect(agent.status().reason).toBe('OFFLINE');
  });

  it('never captures without the operating system permission, and says so to the server', async () => {
    const { agent, captured } = await setup({ osPermission: 'denied' });
    await advance(3600_000);
    expect(captured).toHaveLength(0);
    expect(agent.status().reason).toBe('PERMISSION_MISSING');
    expect(state.lastHeartbeat).toMatchObject({ state: 'PERMISSION_MISSING', osPermission: 'denied' });
  });

  it('skips captures while an excluded app is in front, or when the front app is unknown', async () => {
    const { agent, captured } = await setup({ permit: { excludedApps: ['1Password'] }, frontmost: '1Password 8' });
    await advance(300_000);
    expect(captured).toHaveLength(0);
    expect(agent.status().skippedExcluded).toBe(1);

    const unknown = await setup({ permit: { excludedApps: ['Signal'] }, frontmost: null });
    await advance(300_000);
    expect(unknown.captured).toHaveLength(0);
  });

  it('passes the blur setting to the capturer', async () => {
    const { queue } = await setup({ permit: { blur: true } });
    await advance(300_000);
    const [entry] = await queue.list();
    expect((await queue.read(entry.name)).bytes.toString()).toBe('jpeg-bytes-blur-true');
  });
});

describe('revocation and uploads', () => {
  it('wipes keys, queue and settings when the device is revoked', async () => {
    const { agent, secrets, store, queue } = await setup();
    await advance(300_000);
    state.revoked = true;
    await agent.heartbeat();
    expect(agent.status()).toMatchObject({ paired: false, disconnected: true, reason: 'DISCONNECTED', capturing: false });
    expect(secrets.map.size).toBe(0);
    expect(store.value).toBeNull();
    expect((await queue.stats()).depth).toBe(0);
  });

  it('keeps captures and backs off when the network fails, and drops permanent refusals', async () => {
    let mode = 'offline';
    const { agent, queue } = await setup({
      routes: {
        '/uploads/presign': () => {
          if (mode === 'offline') throw new TypeError('fetch failed');
          return fail(422, 'CAPTURE_NOT_PERMITTED');
        },
      },
    });
    await advance(300_000);
    await agent.drain();
    expect((await queue.stats()).depth).toBe(1);
    expect(agent.status().lastError).toMatch(/fetch failed|Network/);

    mode = 'refused';
    await advance(600_000, { tick: false }); // past the backoff
    await agent.drain();
    expect((await queue.stats()).depth).toBe(0);
  });

  it('skips the storage PUT when the server already has the bytes', async () => {
    const { agent } = await setup({ routes: { '/uploads/presign': () => ok({ screenshotId: 's', status: 'UPLOADED', upload: null }) } });
    await advance(300_000);
    await agent.drain();
    expect(state.uploads).toHaveLength(0);
    expect(env.server.calls.map((c) => c.path)).not.toContain('/uploads/complete');
  });

  it('reports captures dropped from a full or expired queue so gaps are explained', async () => {
    const { agent } = await setup({ routes: { '/uploads/presign': () => { throw new TypeError('fetch failed'); } } });
    await advance(300_000);
    await agent.drain(); // offline: kept
    t += 73 * 3600_000; // beyond the 72 h queue limit
    state.permit = {};
    env.server.calls.length = 0;
    await agent.drain();
    expect(state.failed).toEqual([expect.objectContaining({ code: 'EXPIRED', policyVersionId: VERSION_ID })]);
  });
});

describe('token expiry during uploads', () => {
  it('refreshes once on a 401 and retries the upload', async () => {
    let first = true;
    const { agent, queue } = await setup({
      routes: {
        '/uploads/presign': (body) => {
          if (first) {
            first = false;
            return fail(401, 'INVALID_TOKEN');
          }
          return ok({ screenshotId: 's', status: 'PENDING_UPLOAD', upload: { url: 'https://storage.test/tmp/y', method: 'PUT', headers: { 'Content-Type': body.mimeType } } });
        },
      },
    });
    await advance(300_000);
    await agent.drain();
    expect(state.tokens).toBe(1);
    expect((await queue.stats()).depth).toBe(0);
  });
});

describe('idle time', () => {
  it('reports intervals without input only when the policy enables it', async () => {
    let idleS = 0;
    const { agent } = await setup({ permit: { idleDetectionEnabled: true }, idle: async () => idleS });
    await advance(60_000);
    idleS = 400; // the OS says: no input for 400 s
    await advance(1000);
    idleS = 2; // input again
    await advance(1000);
    await agent.drain();
    expect(state.idle).toHaveLength(1);
    const [interval] = state.idle;
    expect((Date.parse(interval.endedAt) - Date.parse(interval.startedAt)) / 1000).toBe(399);
    expect(Object.keys(interval).sort()).toEqual(['endedAt', 'id', 'startedAt']); // durations only
  });

  it('never measures idle time when the policy does not enable it', async () => {
    const { agent } = await setup({ idle: async () => 900 });
    await advance(120_000);
    await agent.drain();
    expect(state.idle).toBeUndefined();
  });

  it('closes an open interval when the person goes on a break', async () => {
    const { agent } = await setup({ permit: { idleDetectionEnabled: true }, idle: async () => 600 });
    await advance(60_000);
    state.permit = { capture: false, reason: 'ON_BREAK' };
    await advance(60_000);
    await agent.drain();
    expect(state.idle).toHaveLength(1);
  });
});
