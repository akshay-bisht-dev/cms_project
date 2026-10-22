# Phase 5: Attendance, time tracking and timesheets (report)

**Date:** 2026-10-21 · **Status:** complete

## What was built
- **Schema** (migration `…_attendance_time_timesheets`, 15 composite tenant FKs): work schedules and assignments (member > team > department > default), holidays, `member_work_states` (per-member lock row), attendance records, work and break sessions, corrections, time entries and revisions, timesheets, timesheet entries (UNIQUE per entry, so no double counting), and append-only timesheet approvals (DB triggers).
- **Transitions:** clock in/out, breaks, and a timer (start/pause/resume/switch/stop) with server timestamps. Every transition locks the member's state row. The row is created outside the transaction to avoid gap-lock deadlocks (found under a 20-way concurrency test).
- **Calendar rules:** Luxon in the member's zone. The work date is the local start date (overnight stays on the start day). DST gaps shift forward, overlaps take the earlier offset, and durations come from instants. Unit-tested on the 2026 US DST dates.
- **Corrections:** add, modify or delete, with an approval workflow, separation of duties, the original kept on the correction, and a CORRECTED flag.
- **Jobs:**
  - Missed clock-out, every 15 min: closes at the last activity, else the scheduled end, else the cap. Flags the session and notifies the employee.
  - Absences, hourly: marks yesterday in each org's own zone. Skips holidays. Idempotent.
- **Time entries:** manual add/edit/delete under the member lock, overlap checks, revision history, PERIOD_LOCKED for submitted or approved periods, and an org setting to disallow manual entries.
- **Timesheets:** daily, weekly, bi-weekly or semi-monthly periods. Submit (locks entries and fingerprints them) → approve or reject (reject requires a comment and unlocks) → reopen (`timesheets.unlock`). CSV (formula-safe) and PDF exports.
- **UI:** a top-bar time control (live, server-aligned clock), My Time week view, Attendance (month, team board, corrections and review), Timesheets (current period, approvals queue, detail with history and exports), Attendance & time settings (schedules, holidays, rules), the profile Attendance and Timesheets tabs, and dashboard tiles for working now, on break, tracked today and waiting for approval.

## Verification (run on 2026-10-21)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit / integration (real MySQL) | **73/73** · **302/302** (103 operations, all covered by the generated 401/403 suite) |
| Web unit | **13/13** (incl. zoned-time DST conversions) |
| Playwright E2E + axe | **10/10**: full employee loop (clock, timer, manual time, submit), lead approval, owner schedule; no serious accessibility violations |

Mandatory cases covered: duplicate clock-in (20 concurrent → exactly 1), overlapping sessions and entries, timer recovery after refresh, overnight shifts, DST, manual corrections, timesheet approval/rejection, double counting, missed clock-out.

## Bugs found and fixed
- A deadlock (MySQL 1213) when concurrent first-time transitions inserted the state row inside the transaction.
- Popover totals were static between refetches. The board's times used the browser's time zone.
- The axe scan ran during toast animations. The helper now waits for animations to settle.

## Known limitations
- `projectId`/`taskId` on entries have no FKs or pickers until Phase 6.
- The attendance board resolves each member's schedule individually (fine for hundreds; needs batching for thousands).
- Changing the timesheet period applies to new periods. A new period starting on an existing sheet's start date reuses that sheet.
- Leave isn't considered for absences until Phase 10. Holidays are org-wide (no per-location calendars).
- The worker's job schedules and the Redis paths are still unrun locally (no Docker).
