import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCapturer, fitWithin } from '../src/capture.js';
import { createPermissions } from '../src/permissions.js';
import { createSecretStore, createSettingsStore, loadQueueKey } from '../src/settings.js';
import { normalizeServerUrl } from '../src/api-client.js';

// Stand-ins for Electron APIs (the modules receive them by injection).
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString(),
});

function fakeImage(width, height, label = 'img') {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => fakeImage(w, h ?? Math.round((height * w) / width), `${label}>${w}`),
    toJPEG: (q) => Buffer.from(`${label}@${width}x${height}q${q}`),
  };
}

describe('settings and secrets', () => {
  it('keeps pairing and preferences separately, and keeps preferences on disconnect', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orbit-settings-'));
    const store = createSettingsStore({ dir });
    await store.save({ serverUrl: 'https://o.test', agentId: 'a' });
    await store.setPreference('showCaptureNotifications', false);
    expect(await store.load()).toEqual({ serverUrl: 'https://o.test', agentId: 'a' });
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(await store.preferences()).toEqual({ showCaptureNotifications: false });
  });

  it('stores secrets only through the OS keychain, never in plaintext', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orbit-secrets-'));
    const secrets = createSecretStore({ dir, safeStorage: fakeSafeStorage() });
    const key = await loadQueueKey(secrets);
    expect(key).toHaveLength(32);
    expect((await loadQueueKey(secrets)).equals(key)).toBe(true);
    const raw = await readFile(path.join(dir, 'queue-key.secret'), 'utf8');
    expect(raw.startsWith('enc:')).toBe(true);
    const noKeychain = createSecretStore({ dir, safeStorage: fakeSafeStorage(false) });
    await expect(noKeychain.write('x', 'y')).rejects.toThrow(/keychain/);
  });
});

describe('permissions', () => {
  it('reports the macOS screen-recording status and opens System Settings after a denial', async () => {
    const shell = { openExternal: vi.fn(async () => {}) };
    const desktopCapturer = { getSources: vi.fn(async () => []) };
    let status = 'denied';
    const perms = createPermissions({ platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => status }, shell, desktopCapturer });
    expect(await perms.status()).toBe('denied');
    await perms.request();
    expect(shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    status = 'not-determined';
    await perms.request();
    expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1); // shows the system prompt
  });
});

describe('capture', () => {
  it('fits large screens within 1920 px without enlarging small ones', () => {
    expect(fitWithin(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(1280, 800)).toEqual({ width: 1280, height: 800 });
  });

  it('captures only the display under the pointer, or each display, and blurs on the device', async () => {
    const displays = [
      { id: 1, size: { width: 1440, height: 900 }, scaleFactor: 2 },
      { id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    ];
    const screen = { getAllDisplays: () => displays, getCursorScreenPoint: () => ({ x: 2000, y: 10 }), getDisplayNearestPoint: () => displays[1] };
    const desktopCapturer = {
      getSources: vi.fn(async () => [
        { display_id: '1', thumbnail: fakeImage(1920, 1200, 'd1') },
        { display_id: '2', thumbnail: fakeImage(1920, 1080, 'd2') },
      ]),
    };
    const capturer = createCapturer({ desktopCapturer, screen });
    const [active] = await capturer.capture({ mode: 'ACTIVE_SCREEN' });
    expect(active).toMatchObject({ width: 1920, height: 1080, mimeType: 'image/jpeg' });
    expect(active.bytes.toString()).toBe('d2@1920x1080q70');
    expect(await capturer.capture({ mode: 'ALL_SCREENS' })).toHaveLength(2);
    const [blurred] = await capturer.capture({ mode: 'ACTIVE_SCREEN', blur: true });
    expect(blurred.bytes.toString()).toBe('d2>80>1920@1920x1080q70');
  });

  it('fails loudly (never silently) when the OS returns an empty image', async () => {
    const screen = { getAllDisplays: () => [], getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ id: 9, size: { width: 10, height: 10 }, scaleFactor: 1 }) };
    const capturer = createCapturer({ desktopCapturer: { getSources: async () => [{ display_id: '9', thumbnail: { isEmpty: () => true } }] }, screen });
    await expect(capturer.capture()).rejects.toThrow(/permission/);
  });
});

describe('server address', () => {
  it('requires https except for a local development server', () => {
    expect(normalizeServerUrl('https://orbit.example.com/some/path')).toBe('https://orbit.example.com');
    expect(normalizeServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => normalizeServerUrl('http://orbit.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('orbit')).toThrow(/full address/);
  });
});
