import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import updater from 'electron-updater';
import { createAgent } from './agent.js';
import { createDeviceKeys } from './authentication.js';
import { createCapturer } from './capture.js';
import { createFrontmostApp } from './frontmost-app.js';
import { createLocalQueue } from './local-queue.js';
import { createPermissions } from './permissions.js';
import { createSecretStore, createSettingsStore, loadQueueKey } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = (name) => path.join(here, '..', 'assets', name);
const TRAY_ICONS = { capturing: 'tray-capturing.png', paused: 'tray-paused.png', off: 'tray-off.png', flash: 'tray-flash.png' };

// One instance only: two agents would double-capture.
if (!app.requestSingleInstanceLock()) app.quit();

let tray = null;
let win = null;
let agent = null;
let settings = null;
let lastStatus = null;

const log = (level, message) => (level === 'error' ? console.error : console.warn)(`[orbit-agent] ${message}`);

function icon(state) {
  return nativeImage.createFromPath(asset(TRAY_ICONS[state]));
}

function trayState(status) {
  if (status.capturing) return 'capturing';
  return status.paired ? 'paused' : 'off';
}

function updateTray(status) {
  if (!tray) return;
  tray.setImage(icon(trayState(status)));
  tray.setToolTip(`Orbit Desktop — ${status.text}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status.text, enabled: false },
      ...(status.lastCaptureAt ? [{ label: `Last screenshot ${new Date(status.lastCaptureAt).toLocaleTimeString()}`, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Open Orbit Desktop', click: showWindow },
      ...(status.serverUrl ? [{ label: 'What is captured and who can see it', click: () => shell.openExternal(`${status.serverUrl}/monitoring`) }] : []),
      { type: 'separator' },
      { label: 'Quit Orbit Desktop', click: () => app.quit() },
    ]),
  );
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 440,
    height: 600,
    resizable: false,
    title: 'Orbit Desktop',
    show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

async function onCaptured({ at }) {
  // Visible indicator on every capture: the tray icon flashes; a notification is optional.
  tray?.setImage(icon('flash'));
  setTimeout(() => lastStatus && updateTray(lastStatus), 800);
  const prefs = await settings.preferences();
  if (prefs.showCaptureNotifications && Notification.isSupported()) {
    new Notification({ title: 'Screenshot taken', body: `At ${new Date(at).toLocaleTimeString()}. Open Orbit to see it.`, silent: true }).show();
  }
}

function registerIpc() {
  ipcMain.handle('status:get', () => agent.status());
  ipcMain.handle('pair', async (_e, { serverUrl, code }) => {
    try {
      await agent.pair({ serverUrl, code, deviceName: os.hostname().slice(0, 120), os: process.platform, osVersion: os.release() });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
  ipcMain.handle('disconnect', () => agent.disconnect('user'));
  ipcMain.handle('permission:request', async () => {
    await permissions.request();
    await agent.refreshPermission();
    return agent.status();
  });
  ipcMain.handle('permission:open', () => permissions.openSettings());
  ipcMain.handle('open:monitoring', () => lastStatus?.serverUrl && shell.openExternal(`${lastStatus.serverUrl}/monitoring`));
  ipcMain.handle('prefs:get', () => settings.preferences());
  ipcMain.handle('prefs:set', (_e, { name, value }) => {
    if (name !== 'showCaptureNotifications' || typeof value !== 'boolean') return null;
    return settings.setPreference(name, value);
  });
}

const permissions = createPermissions({ platform: process.platform, systemPreferences, shell, desktopCapturer });

app.on('second-instance', showWindow);
// The status window is optional; the tray icon keeps the agent visible while it runs.
app.on('window-all-closed', () => {});
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.orbit.desktop');
  const dir = app.getPath('userData');
  settings = createSettingsStore({ dir });
  const secrets = createSecretStore({ dir: path.join(dir, 'secrets'), safeStorage });
  const queue = createLocalQueue({ dir: path.join(dir, 'queue'), key: await loadQueueKey(secrets) });

  agent = createAgent({
    store: settings,
    keys: createDeviceKeys({ secrets }),
    queue,
    capturer: createCapturer({ desktopCapturer, screen }),
    permissions,
    frontmostApp: createFrontmostApp({ platform: process.platform, execFile }),
    idleSeconds: async () => powerMonitor.getSystemIdleTime(),
    appVersion: app.getVersion(),
    log,
    onCaptured,
    onStatus: (status) => {
      lastStatus = status;
      updateTray(status);
      if (win && !win.isDestroyed()) win.webContents.send('status', status);
    },
  });

  tray = new Tray(icon('off'));
  registerIpc();
  await agent.init();
  agent.start();
  powerMonitor.on('resume', () => agent.heartbeat());
  if (!agent.status().paired) showWindow();

  if (app.isPackaged && process.env.ORBIT_UPDATE_URL) {
    // Signed builds only; electron-updater verifies the signature before installing.
    updater.autoUpdater.checkForUpdatesAndNotify().catch((err) => log('warn', `Update check failed: ${err.message}`));
  }
});
