import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Non-secret settings (server address, agent id, device name, preferences) as JSON. */
export function createSettingsStore({ dir }) {
  const file = path.join(dir, 'settings.json');
  async function readAll() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return {};
    }
  }
  async function writeAll(value) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  }
  return {
    async load() {
      const all = await readAll();
      return all.pairing ?? null;
    },
    async save(pairing) {
      await writeAll({ ...(await readAll()), pairing });
    },
    async clear() {
      const { preferences } = await readAll();
      await writeAll({ preferences });
    },
    async preferences() {
      return { showCaptureNotifications: true, ...(await readAll()).preferences };
    },
    async setPreference(name, value) {
      const all = await readAll();
      await writeAll({ ...all, preferences: { ...all.preferences, [name]: value } });
    },
  };
}

/**
 * Secrets encrypted with the OS keychain (Electron safeStorage: Keychain on macOS, DPAPI on
 * Windows, libsecret/kwallet on Linux). Without a keychain we refuse to store secrets at all
 * rather than fall back to plaintext.
 */
export function createSecretStore({ dir, safeStorage }) {
  const fileFor = (name) => path.join(dir, `${name}.secret`);
  function assertAvailable() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No secure storage (OS keychain) is available on this computer');
  }
  return {
    async read(name) {
      assertAvailable();
      try {
        return safeStorage.decryptString(await readFile(fileFor(name)));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(name, value) {
      assertAvailable();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(fileFor(name), safeStorage.encryptString(value), { mode: 0o600 });
    },
    async remove(name) {
      await rm(fileFor(name), { force: true });
    },
  };
}

/** The local queue's AES key: random per install, kept in the secret store. */
export async function loadQueueKey(secrets) {
  const existing = await secrets.read('queue-key');
  if (existing) return Buffer.from(existing, 'base64');
  const key = randomBytes(32);
  await secrets.write('queue-key', key.toString('base64'));
  return key;
}
