# Orbit Desktop (agent)

Transparent, consent-based screenshot capture for **clocked-in work time only**. Design:
[`docs/screenshot-monitoring.md`](../../docs/screenshot-monitoring.md).

## What it does — and does not do
- Captures only when the server's current permit allows it: the person is paired, has
  acknowledged the current notice, the policy is on, and they are clocked in and not on a break.
  It also needs the OS screen-recording permission. A permit expires after ~2 minutes without a
  heartbeat, so an offline agent pauses on its own.
- Always visible: a tray icon (green capturing, amber paused, grey off) that flashes on every
  capture. Optional notification per capture (on by default). A status window explains every
  pause in plain words.
- Never: keystrokes, clipboard, microphone, webcam, URLs or window contents; hidden processes;
  capture without OS permission; capture of excluded apps.
- Blur happens on the device before anything is written to disk.

## Layout
| File | Role |
|---|---|
| `src/agent.js` | Decision logic and loops (tick 1 s, heartbeat 60 s, upload 10 s). No Electron imports; unit-tested. |
| `src/authentication.js` | Ed25519 device key (private key only in the OS keychain), challenge signing. |
| `src/local-queue.js` | AES-256-GCM encrypted queue on disk, ≤ 200 MB / 72 h; evictions are reported to the server. |
| `src/uploader.js` | presign → PUT → complete, idempotent; backoff 2 s → 5 min. |
| `src/capture.js`, `permissions.js`, `frontmost-app.js`, `settings.js` | Thin adapters over Electron/OS APIs (injected, so they are tested with fakes). |
| `src/main.js`, `preload.cjs`, `renderer/` | Electron main process, sandboxed status window (context isolation, no Node, strict CSP). |

## Run (development)
```bash
pnpm --filter @orbit/desktop-agent setup   # downloads the Electron binary (pnpm blocks install scripts)
pnpm --filter @orbit/desktop-agent start   # tray app + status window
pnpm --filter @orbit/desktop-agent test    # unit tests (no Electron needed)
```
In the status window enter the web app's address (for example `http://localhost:3000`) and the
pairing code from **My Monitoring → Connect desktop app**. On macOS, "Grant screen-recording
permission" shows the system prompt; after a denial, it opens System Settings.

## Distribution
`pnpm --filter @orbit/desktop-agent dist` builds unsigned installers. Shipping needs an Apple
Developer ID (hardened runtime + notarization) and a Windows code-signing certificate, plus
`ORBIT_UPDATE_URL` for signed auto-updates (electron-updater). This is tracked for Phase 11.
