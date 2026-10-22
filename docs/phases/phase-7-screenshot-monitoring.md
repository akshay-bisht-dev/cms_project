# Phase 7: Screenshot monitoring (report)

**Date:** 2026-10-21 · **Status:** complete, except running the Electron app on a real desktop. The agent's logic is unit-tested, but the GUI and OS capture have not been exercised (see Limitations).

## Objective
Transparent, consent-based screenshot monitoring:
- Policies with defined precedence, and employee notice and acknowledgement.
- A desktop agent that authenticates with a device key.
- An idempotent, validated upload pipeline into private storage.
- A gallery that explains gaps and logs every access.
- Retention with legal holds.

## What was built
- **Schema** (migration `…_monitoring`):
  - `capture_policies` (exactly one ORG policy per org)
  - immutable `monitoring_policy_versions`
  - `capture_policy_assignments`
  - append-only `monitoring_consent_records`
  - `agent_pairing_codes`
  - `desktop_agents` (Ed25519 public key, status, last state)
  - `screenshots` (unique per agent + `clientCaptureId`; status `PENDING_UPLOAD → UPLOADED → READY | FAILED | REJECTED | DELETED`; retention and legal-hold flags)
  - `screenshot_access_logs` (PK `id, at`, no FKs, ready for partitioning)
  - `screenshot_deletion_logs`
  - `legal_holds` and their targets

  Database triggers block updates and deletes on consent records, block updates on versions, and block updates on both logs. No image bytes ever touch MySQL.
- **Policy resolution:**
  1. The ORG master switch.
  2. A MEMBER assignment.
  3. A TEAM assignment: highest priority wins, then the less invasive policy (capture off, then longer interval, then blur).
  4. Otherwise the ORG policy.

  The interval is clamped to the ORG bounds, and retention can only shrink. The notice hash covers the text and every material setting, so any change requires a fresh acknowledgement.
- **Agent authentication:**
  - Pairing: a one-time 8-character code (5 minutes, newest only), then registration with a raw Ed25519 public key. The employee is notified, by email by default.
  - Token: a challenge nonce (60 s, only the latest valid, consumed atomically) is signed by the device and exchanged for a 15-minute HS256 token (`aud=agent`).
  - Every request re-checks that the agent and member are ACTIVE. A new `AGENT` access level keeps agent tokens and browser sessions strictly apart.
  - Revocation happens via the employee, an admin, deactivation or offboarding, or any password reset.
- **Capture permit** (heartbeat): `capture` with a reason (`MONITORING_OFF`, `POLICY_DISABLED`, `CONSENT_REQUIRED`/`WITHDRAWN`, `CLOCKED_OUT`, `ON_BREAK`), interval, blur, screens, excluded apps, and a 2-minute expiry.
- **Uploads:**
  - presign: re-validates that capture was allowed at `capturedAt`. The consent in force must match that version's hash, the version must enable capture, and the time must fall inside a work session and outside breaks. Project and task come from the running time entry, never from the agent.
  - PUT to `tmp/`, then complete (HEAD-verified), then the outbox event `screenshot.process`.
  - Worker: SHA-256 recheck, sharp decode with a pixel limit, WebP re-encode without metadata, 320 px thumbnail, move to `captures/`/`thumbs/`, `READY` with `retention_expires_at`.
  - `/uploads/fail` records captures that will never arrive, so gaps are explained.
- **Jobs:**
  - Daily retention purge (02:00 UTC). Objects are deleted first; then the row is marked DELETED and logged. Legal holds are re-checked per row.
  - Hourly stale-upload sweep (`UPLOAD_TIMEOUT`).
- **Viewing:**
  - Scoped list and a day timeline (sessions, breaks, captures including failures, devices).
  - Batch signed URLs (60 s). Every thumbnail view, full view and download is logged; download needs its own permission.
  - The access history is visible to the person captured and to org-wide deleters.
  - Owner-only delete (409 under legal hold) and a deletion log.
- **Legal holds:** on members or projects with UTC date ranges. Applied to existing rows and at insert; release recomputes from the remaining holds. Audited.
- **UI:**
  - **My Monitoring** (employee): live state, full notice and settings in plain words, what is never captured, acknowledge or withdraw (with HR caveat), who can see screenshots (role and reach), devices with pairing code and disconnect, acknowledgement history.
  - **Screenshots:** a day timeline by hour (DST-safe). Every working hour without captures says why: break, monitoring off, no desktop app, or offline/paused.
  - Viewer with download, delete and access history.
  - **Settings → Monitoring:** master switch with confirmation, policy editor and version history, team and individual policies with assignments, all devices, legal holds, deletion log.
  - Profile **App Settings** and **Screenshots** tabs are now live, and the sidebar Screenshots and My Monitoring links are enabled.
- **Desktop agent** (`apps/desktop-agent`, Electron 44.9.3; Tauri was rejected because it needs Rust): see its [README](../../apps/desktop-agent/README.md).
  - Logic is free of Electron so it can be tested: the decision loop, keychain-held device key, encrypted queue (AES-256-GCM, ≤ 200 MB / 72 h, evictions reported), and idempotent uploader with backoff.
  - The Electron shell: tray with state icons that flash on capture, a sandboxed status window, on-device blur, active-screen or per-display capture, OS permission handling (never bypassed), and excluded apps (a capture is skipped if the front app is unknown).
  - Packaging config for macOS (hardened runtime, screen-capture usage string), Windows and Linux. Signed auto-update is behind `ORBIT_UPDATE_URL`.

## Permissions
These permissions already existed in the catalog: `monitoring.self`, `.policy.read`, `.policy.manage`, `.screenshots.read`, `.screenshots.download`, `.screenshots.delete`, `.legalhold.manage`, `.agents.manage`. New error codes: `AGENT_REVOKED`, `CONSENT_REQUIRED`, `CAPTURE_NOT_PERMITTED`, `LEGAL_HOLD`. New rate-limit classes: `agent` (per device) and `agent-auth` (per IP).

## Verification (run on 2026-10-21)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit | **80/80** (+6: token tamper/expiry, challenge expiry, signature binding, pairing alphabet, notice hash) |
| API integration (real MySQL) | **475/475** (+20 monitoring scenarios; 178 operations, all in the generated 401/403 suite, plus "agent routes refuse sessions") |
| Desktop agent unit | **31/31**, including a contract test that the agent signs exactly what the API verifies |
| Web unit | **17/17** (+4 gap-explanation and DST tests) |
| Playwright E2E + axe | **17/17** (+4: owner enables and publishes; employee acknowledges, pairs a device via the real API and sees it; timeline explains gaps; manager views and employee disconnects) |
| Visual review | My Monitoring, pairing dialog, settings, policy editor, profile App Settings (1440 px), Screenshots (390 px) |

The monitoring integration tests cover:
- Duplicate presign and complete are idempotent; a different checksum returns 409.
- Real sharp processing: a non-image is `REJECTED`, swapped bytes give `CHECKSUM_MISMATCH`, and a size mismatch is refused.
- Consent gating, including re-acknowledgement after a material change, withdrawal and the master switch.
- Captures outside a session, on a break, before the policy, or in the future are refused. Offline captures uploaded after clock-out are accepted.
- Revocation (self, offboarding) takes effect immediately; a peer cannot revoke a device.
- Peers and other organizations get 403/404 on every read, URL and delete path. Downloads need their own permission. Access logs are written and visible to the right people.
- Retention skips held captures and deletes after release (objects, row, log). Holds apply to later captures. Owners can delete, and deletion is audited.
- Policy precedence and clamping. Consent records and published versions are immutable in the database.

## Bugs found and fixed
1. **Transient upload failures were silent.** The agent backed off without surfacing why, so neither the status window nor the server heartbeat showed that uploads were stuck. They now report `Upload failed: …`.
2. **Form alignment:** fields with a hint stretched their grid row and misaligned neighbouring inputs. `FormField` now packs to the top; this affects every form.
3. Several of my own test-setup mistakes, caught on the first runs and not product bugs: captures timestamped before the policy, permits allowed to expire, a 15-minute token outliving a test, an ambiguous selector, and a queue limit below the encryption overhead.

## Commands
```bash
pnpm --filter @orbit/api exec dotenv -e ../../.env -- prisma migrate deploy
pnpm --filter @orbit/api test            # unit + integration
pnpm --filter @orbit/desktop-agent test
pnpm --filter @orbit/web test && pnpm --filter @orbit/web test:e2e
pnpm --filter @orbit/desktop-agent setup && pnpm --filter @orbit/desktop-agent start   # run the agent
```

## Limitations (honest list)
- **Not run on a real desktop:**
  - The Electron app (tray, status window, `desktopCapturer`, the macOS permission prompt, the keychain via `safeStorage`, front-app detection) has not been started. Its entry files are syntax-checked; its logic is unit-tested with fakes.
  - The roadmap's acceptance item "agent captures and uploads end to end on macOS with the OS prompt shown" remains to do on your machine.
- **Not run against real object storage:** no Docker here, so presigned PUT/GET against SeaweedFS/S3 is untested. Tests use an in-memory store, but image processing used real sharp. The worker's BullMQ wiring for `screenshot.process` and the retention schedule were not run against Redis.
- **No push for policy changes:** agents notice within one heartbeat (≤ 60 s).
- **Idle time:** disclosed in the notice but not recorded (Phase 8).
- **Web CSP:** there is none yet. When it is added (Phase 11), `img-src` must allow the storage origin for thumbnails.
- **Agent distribution:** unsigned until the Apple Developer ID and Windows certificate exist.
- Monitoring reports (coverage, storage usage, agent health) are Phase 8.

## Acceptance criteria
| Criterion | Status |
|---|---|
| Idempotent duplicate upload test | ✅ |
| Unauthorized access test | ✅ (peer, other org, download without permission, agent ↔ session separation) |
| Retention job test | ✅ with a fake store and real DB; ⏳ against MinIO/SeaweedFS (needs Docker) |
| Agent captures and uploads end to end on macOS with the OS prompt | ⏳ needs a manual run (`setup` + `start`) |
