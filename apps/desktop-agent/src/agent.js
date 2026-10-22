import { createHash, randomUUID } from 'node:crypto';
import { createAgentApi, normalizeServerUrl } from './api-client.js';
import { createUploader } from './uploader.js';
import { nextCaptureDelayMs, permitExpiresAtLocal } from './scheduler.js';

export const HEARTBEAT_MS = 60_000;
const TICK_MS = 1000;
const DRAIN_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** No keyboard or mouse input for this long starts an idle interval. */
export const IDLE_THRESHOLD_S = 300;

/** Status shown in the tray and the status window, in plain words. */
export const PAUSE_TEXT = {
  UNPAIRED: 'Not connected to Orbit',
  DISCONNECTED: 'Disconnected from Orbit',
  OFFLINE: 'Paused: cannot reach Orbit',
  NOT_CONFIGURED: 'Off: monitoring is not set up',
  MONITORING_OFF: 'Off: monitoring is turned off',
  POLICY_DISABLED: 'Off: your policy does not take screenshots',
  CONSENT_REQUIRED: 'Paused: acknowledge the monitoring notice in Orbit',
  CONSENT_WITHDRAWN: 'Off: you withdrew your acknowledgement',
  CLOCKED_OUT: 'Paused: you are clocked out',
  ON_BREAK: 'Paused: you are on a break',
  PERMISSION_MISSING: 'Paused: screen-recording permission is not granted',
};

const isExcluded = (app, excluded) => excluded.some((name) => app.toLowerCase() === name.toLowerCase() || app.toLowerCase().includes(name.toLowerCase()));

/**
 * The agent's decision logic, independent of Electron so it can be tested. Capture happens only
 * when the server's current permit allows it (paired, notice acknowledged, policy on, clocked in,
 * not on break) AND the operating system has granted screen-recording permission. A permit that
 * has not been renewed within two heartbeats expires, so an offline agent pauses on its own.
 */
export function createAgent({
  store,
  keys,
  queue,
  capturer,
  permissions,
  frontmostApp = async () => null,
  idleSeconds = async () => 0,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  appVersion = '0.0.0',
  log = () => {},
  onStatus = () => {},
  onCaptured = () => {},
}) {
  let config = null;
  let api = null;
  let uploader = null;
  let token = null;
  let tokenExpiresAt = 0;
  let permit = null;
  let permitReceivedAt = 0;
  let nextCaptureAt = null;
  let uploadRetryAt = 0;
  let busy = false;
  let lastError = null;
  let uploadError = null;
  let osPermission = 'unknown';
  let lastCaptureAt = null;
  let skippedExcluded = 0;
  let disconnected = false;
  let queueStats = { depth: 0, bytes: 0 };
  let identity = null;
  // Idle tracking (only when the policy enables it): durations without input, never the input.
  let idleStart = null;
  const pendingIdle = [];

  function connect(cfg) {
    config = cfg;
    api = createAgentApi({ serverUrl: cfg.serverUrl, fetchImpl, getToken: () => token, userAgent: `OrbitDesktop/${appVersion}` });
    uploader = createUploader({ api, queue, refreshToken, random, log });
  }

  function evaluate(at = now()) {
    if (disconnected) return { capturing: false, reason: 'DISCONNECTED' };
    if (!config) return { capturing: false, reason: 'UNPAIRED' };
    if (!permit || at > permitExpiresAtLocal(permit, permitReceivedAt)) return { capturing: false, reason: 'OFFLINE' };
    if (!permit.capture) return { capturing: false, reason: permit.reason };
    if (osPermission !== 'granted') return { capturing: false, reason: 'PERMISSION_MISSING' };
    return { capturing: true, reason: null };
  }

  function status() {
    const ev = evaluate();
    return {
      paired: Boolean(config),
      disconnected,
      capturing: ev.capturing,
      reason: ev.reason,
      text: ev.capturing ? `Capturing every ${Math.round(permit.intervalS / 60)} min while you work` : PAUSE_TEXT[ev.reason] ?? `Paused: ${ev.reason}`,
      serverUrl: config?.serverUrl ?? null,
      deviceName: config?.deviceName ?? null,
      organization: identity?.organization ?? null,
      member: identity?.member ?? null,
      intervalS: permit?.intervalS ?? null,
      blur: permit?.blur ?? false,
      excludedApps: permit?.excludedApps ?? [],
      osPermission,
      lastCaptureAt,
      skippedExcluded,
      queue: queueStats,
      lastError: lastError ?? uploadError,
    };
  }

  const emit = () => onStatus(status());

  async function refreshToken() {
    const { nonce } = await api.challenge(config.agentId);
    const ts = Math.floor(now() / 1000);
    const signature = await keys.signChallenge({ agentId: config.agentId, nonce, ts });
    const issued = await api.token({ agentId: config.agentId, nonce, ts, signature });
    token = issued.accessToken;
    tokenExpiresAt = Date.parse(issued.expiresAt);
  }

  async function ensureToken() {
    if (!token || now() > tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) await refreshToken();
  }

  async function handleError(err, context) {
    if (err?.code === 'AGENT_REVOKED') {
      await agent.disconnect('revoked');
      return;
    }
    lastError = `${context}: ${err?.message ?? err}`;
    log('warn', lastError);
  }

  async function record(kind, meta, bytes) {
    await queue.add(kind, meta, bytes);
    queueStats = await queue.stats();
  }

  const agent = {
    status,

    async init() {
      const saved = await store.load();
      if (saved?.serverUrl && saved?.agentId) connect(saved);
      osPermission = await permissions.status();
      queueStats = await queue.stats();
      emit();
    },

    /** Pairs this device using the one-time code shown on the employee's /monitoring page. */
    async pair({ serverUrl, code, deviceName, os, osVersion }) {
      const origin = normalizeServerUrl(serverUrl);
      const publicKey = await keys.generate();
      const pairingApi = createAgentApi({ serverUrl: origin, fetchImpl, userAgent: `OrbitDesktop/${appVersion}` });
      const res = await pairingApi.register({ pairingCode: code, publicKey, deviceName, os, osVersion, agentVersion: appVersion });
      const cfg = { serverUrl: origin, agentId: res.agentId, deviceName };
      await store.save(cfg);
      disconnected = false;
      connect(cfg);
      token = res.accessToken;
      tokenExpiresAt = Date.parse(res.expiresAt);
      identity = { organization: res.organization, member: res.member };
      lastError = null;
      await agent.heartbeat();
    },

    async heartbeat() {
      if (!config || disconnected) return emit();
      osPermission = await permissions.status();
      queueStats = await queue.stats();
      const ev = evaluate();
      try {
        await ensureToken();
        const res = await api.heartbeat({
          state: ev.capturing ? 'CAPTURING' : osPermission !== 'granted' && osPermission !== 'unknown' ? 'PERMISSION_MISSING' : 'PAUSED',
          queueDepth: queueStats.depth,
          queueBytes: queueStats.bytes,
          osPermission,
          ...((lastError ?? uploadError) ? { lastError: (lastError ?? uploadError).slice(0, 500) } : {}),
          agentVersion: appVersion,
        });
        const wasCapturing = permit?.capture;
        permit = res;
        permitReceivedAt = now();
        identity = { organization: res.organization, member: res.member };
        lastError = null;
        // Resuming after a pause: the first capture lands at a random point in the first interval.
        if (permit.capture && (!wasCapturing || nextCaptureAt === null)) nextCaptureAt = now() + Math.round(random() * permit.intervalS * 1000);
        if (!permit.capture) nextCaptureAt = null;
      } catch (err) {
        await handleError(err, 'Heartbeat failed');
      }
      emit();
    },

    /** Closes or opens an idle interval from the OS idle time (seconds since last input). */
    async trackIdle() {
      const eligible = evaluate().capturing && permit?.idleDetectionEnabled;
      if (!eligible) {
        if (idleStart !== null) pendingIdle.push({ id: randomUUID(), startedAt: new Date(idleStart).toISOString(), endedAt: new Date(now()).toISOString() });
        idleStart = null;
        return;
      }
      const idleS = await idleSeconds();
      if (idleS >= IDLE_THRESHOLD_S && idleStart === null) idleStart = now() - idleS * 1000;
      else if (idleS < IDLE_THRESHOLD_S && idleStart !== null) {
        pendingIdle.push({ id: randomUUID(), startedAt: new Date(idleStart).toISOString(), endedAt: new Date(now() - idleS * 1000).toISOString() });
        idleStart = null;
      }
    },

    /** Called every second: tracks idle time and captures when permitted and due. */
    async tick() {
      if (busy) return;
      await agent.trackIdle();
      const ev = evaluate();
      if (!ev.capturing || nextCaptureAt === null || now() < nextCaptureAt) return;
      busy = true;
      try {
        await agent.captureNow();
      } finally {
        nextCaptureAt = now() + nextCaptureDelayMs(permit.intervalS, random);
        busy = false;
        emit();
      }
    },

    async captureNow() {
      const capturedAt = new Date(now()).toISOString();
      const base = { capturedAt, policyVersionId: permit.policyVersionId };
      if (permit.excludedApps?.length) {
        const app = await frontmostApp();
        // If the app in front cannot be determined, err on the side of not capturing.
        if (!app || isExcluded(app, permit.excludedApps)) {
          skippedExcluded += 1;
          return;
        }
      }
      try {
        const images = await capturer.capture({ mode: permit.captureMode, blur: permit.blur });
        for (const image of images) {
          const sha256 = createHash('sha256').update(image.bytes).digest('hex');
          await record('capture', { ...base, clientCaptureId: randomUUID(), sha256, mimeType: image.mimeType, width: image.width, height: image.height }, image.bytes);
        }
        lastCaptureAt = capturedAt;
        onCaptured({ at: capturedAt, count: images.length });
      } catch (err) {
        log('warn', `Capture failed: ${err.message}`);
        await record('failure', { ...base, clientCaptureId: randomUUID(), code: 'CAPTURE_FAILED' });
      }
    },

    /** Uploads queued captures (and reports dropped ones) unless backing off. */
    async drain() {
      if (!config || disconnected || now() < uploadRetryAt) return;
      try {
        if (pendingIdle.length) {
          await ensureToken();
          const batch = pendingIdle.slice(0, 50);
          try {
            await api.idle({ intervals: batch });
            pendingIdle.splice(0, batch.length);
          } catch (err) {
            // Refused (e.g. idle detection was switched off): drop. Network errors: retry later.
            if (err.permanent) pendingIdle.splice(0, batch.length);
            else throw err;
          }
        }
        for (const dropped of await queue.enforceLimits(now())) {
          await record('failure', { clientCaptureId: dropped.clientCaptureId, capturedAt: dropped.capturedAt, policyVersionId: dropped.policyVersionId, code: dropped.reason });
        }
        if ((await queue.stats()).depth === 0) return;
        await ensureToken();
        const res = await uploader.drain();
        uploadRetryAt = res.retryInMs ? now() + res.retryInMs : 0;
        uploadError = res.error ? `Upload failed: ${res.error}` : null;
      } catch (err) {
        await handleError(err, 'Upload failed');
      } finally {
        queueStats = await queue.stats();
        emit();
      }
    },

    /** Forgets this device: deletes the key, the queue and the settings. */
    async disconnect(reason = 'user') {
      log('warn', `Disconnecting (${reason})`);
      await keys.clear();
      await queue.clear();
      await store.clear();
      config = null;
      api = null;
      token = null;
      permit = null;
      nextCaptureAt = null;
      identity = null;
      queueStats = { depth: 0, bytes: 0 };
      uploadError = null;
      idleStart = null;
      pendingIdle.length = 0;
      disconnected = reason === 'revoked';
      emit();
    },

    async refreshPermission() {
      osPermission = await permissions.status();
      emit();
    },

    /** Runs the loops. Returns a stop function. */
    start({ setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
      const timers = [
        setIntervalFn(() => agent.tick().catch((e) => log('error', e.message)), TICK_MS),
        setIntervalFn(() => agent.heartbeat().catch((e) => log('error', e.message)), HEARTBEAT_MS),
        setIntervalFn(() => agent.drain().catch((e) => log('error', e.message)), DRAIN_MS),
      ];
      agent.heartbeat().catch((e) => log('error', e.message));
      return () => timers.forEach((t) => clearIntervalFn(t));
    },
  };
  return agent;
}
