# Phase 8: Activity, insights and reports (report)

**Date:** 2026-10-21 · **Status:** complete (background jobs not yet run against a real Redis worker; see Limitations)

## Objective
Record what happens as append-only activity, roll it up into daily per-member statistics using written, tested formulas, and expose activity timelines, weekly insights and scoped reports. Large reports export to CSV or PDF as background jobs. Every figure is labelled measured, derived or estimated, and nothing is presented as productivity (FR-ACT-1…4, FR-RPT-1…3).

## What was built
- **Schema** (migration `…_activity_reports`):
  - `activity_events`: PK `(id, occurred_at)`, no foreign keys, ready for monthly partitions. A trigger makes it append-only.
  - `daily_member_stats`: one row per member per local day.
  - `stats_dirty_days`: the days that need rebuilding.
  - `report_jobs`.
- **Activity writer** (`recordActivity`): written in the same transaction as the change it describes. Event types are shared with the web app in `ACTIVITY_TYPES`:
  - clock in/out, break start/end, automatic close, attendance correction;
  - timer start/pause/resume/stop/switch;
  - manual time added/edited/deleted, attributed to the person whose time it is, with the actor in metadata;
  - task created, moved, completed, commented;
  - timesheet submitted, approved, rejected;
  - idle intervals from the desktop agent.
- **Keeping stats fresh:** every write marks the affected UTC days dirty. Edits mark both the old and new times, and screenshot status changes mark the capture's day. Stats are rebuilt by:
  - the rollup job every 5 minutes;
  - a nightly pass (yesterday and today for everyone), which catches schedule, holiday and absence changes;
  - each report or insight, which first rebuilds dirty days, "today", and days never computed, within a budget of 1,500 member-days. Beyond the budget, the response is marked incomplete and a backfill job is queued.
- **KPI formulas** (`modules/activity/kpi.js`): pure functions implementing `docs/requirements.md §5`:
  - interval clipping, merging and subtraction;
  - worked and break time; tracked and billable time clipped to the local day (DST-correct);
  - consent windows, monitored time, expected captures, coverage (capped at 100%) and failure rate;
  - utilization, attendance rate, overtime;
  - period summaries.

  Ratios with nothing to divide by return `null` and are shown as "—", never as 0%. The attendance rate counts only scheduled days, so working an unscheduled Saturday can't push it above 100%.
- **Idle detection (FR-ACT-4):**
  - The agent measures OS idle time and opens an interval after 5 minutes without input. It reports only start/end, and only while the server permit allows capture and the policy enables idle detection.
  - The API re-checks the policy and consent, clips intervals to working time (breaks excluded), and is idempotent by interval id.
- **Reports:**
  - Catalog: attendance, time & utilization (by member, project or day), projects (time against estimate, tasks completed, open, overdue), and screenshot coverage. Each column carries its kind and type.
  - Data is limited to the caller's permission scope. Synchronous runs allow up to 31 days and 10,000 rows (`REPORT_TOO_LARGE` beyond that).
  - Exports run as jobs (up to 366 days) producing CSV (Excel-friendly BOM, a totals row, and each column's kind) or PDF (landscape table, kinds legend).
  - Jobs run as the requester with permissions re-loaded, so a queued export fails if access was lost meanwhile. Downloads re-check permission and issue a 60-second link. Requests and downloads are audited. Files expire after 7 days.
- **Activity and insights APIs:**
  - One person's day (totals, ordered events, sessions, breaks, timer entries, project split), week, and team overview with live state.
  - Weekly trends.
  - Monitoring figures (captures, coverage, idle) are removed wherever the viewer's `reports.monitoring.read` scope doesn't cover the person. For example, HR sees attendance but not screenshots.
- **UI:**
  - **Activity:** Day view with lanes for at work, breaks, timer (billable or not) and no-input, plus an event list and project split. Week view with a worked-vs-tracked chart. A Team tab for people with wider scope.
  - **Insights:** small multiples for tracked/billable hours, attendance rate, billable utilization and coverage. Each chart shows its kind and formula, and empty periods explain why they're empty.
  - **Reports:** catalog, parameters, a results table whose headers show each column's kind, a totals row and notes, CSV/PDF export, and My exports with polling and download.
  - The profile Activity tab now shows the person's activity above the profile change history. The sidebar Activity, Insights and Reports links are live.
  - Chart colors `--series-1` and `--series-2` were checked with the dataviz palette validator (lightness, chroma, colour-blind separation, contrast); all checks pass.

## Permissions
No new permissions. Activity and the attendance and time reports use `reports.attendance.read`. The project report uses `reports.projects.read`. Monitoring figures and the coverage report use `reports.monitoring.read`. Exports use `reports.export` plus the report's own permission. The new rate-limit class is `export` (10 per hour per member).

## Verification (run on 2026-10-21)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit | **90/90** (+10 KPI fixture tests: clipping, worked/break, tracked across midnight and a 25-hour DST day, consent windows, coverage, ratios, a fixture week's summary) |
| API integration (real MySQL) | **508/508** (+13 activity/report scenarios; 189 operations in the generated 401/403 suite; OpenAPI drift check) |
| Desktop agent unit | **34/34** (+3 idle tests) |
| Web unit | **17/17** |
| Playwright E2E + axe | **20/20** (+3: employee day/week, team lead's team view, owner insights → report → export) |
| Visual review | Activity (day, week), Insights, Reports at 1440 px; Reports at 390 px |

The integration tests cover:
- Exact event sequences, and the append-only trigger.
- Day stats from a scripted workday: 8 h worked, 30 min break, 8 h billable.
- Editing an earlier day's time rebuilds that day; a missed scheduled day counts as absent.
- Scoping: a peer gets 403; the lead sees the team; HR sees no monitoring fields; the owner sees everything.
- Idle intervals: refused while disabled; clipped so the break is excluded; deduplicated.
- The report catalog per role.
- Attendance and lateness per member, and time and utilization with lateness reducing billable time.
- Time by project, and project hours against the estimate.
- Coverage of 12/16 with a failure rate of 1/13 against seeded captures.
- Range and grouping validation.
- Export jobs: CSV content and kinds, a PDF signature, download auditing, requester-only visibility, and loss of permission blocking both download and job execution.
- File expiry, the compute budget and backfill queueing, and weekly trends.

## Bugs found and fixed
1. **Keyboard access:** the wide report table's scroll container couldn't be reached by keyboard (axe `scrollable-region-focusable`). `Table` now takes a `scrollLabel` that makes the container a labelled, focusable region.
2. **Charts with no data:** rate charts for periods with no schedule drew empty axes with no explanation; they now say why there is no value. Name wrapping and a plural were also fixed.
3. Test-side mistakes, caught on the first runs: my own fixture arithmetic, member join dates later than the fixed test clock, an unscoped query in a test, an agent token outliving the test, and the CSV BOM/CRLF.

## Limitations
- **Not run against real infrastructure:** no Docker here, so the BullMQ schedules (`stats-dirty` every 5 minutes, `stats-nightly`, `report-expiry`) and the `report.generate`/`stats.backfill` deliveries are untested on Redis. The job functions themselves are tested directly against MySQL.
- **Read replica:** reports read the primary database. The replica in the design isn't wired, because the stats refresh writes through the same connection.
- **Coverage is approximate:**
  - Monitored time uses acknowledgement windows (an acknowledgement until the next record). It ignores a notice change that makes an acknowledgement stale until re-acknowledged.
  - The interval comes from that day's capture version, otherwise the current policy.
  - Both are documented in the report notes as derived.
- **Activity history:** events start with this phase; earlier days have stats (rebuilt from source tables) but no event lists.
- **Partitioning** of `activity_events` and the 13-month retention drop are Phase 11.
- **Report scope:** leave, CRM, ticket and finance reports arrive with their phases.

## Acceptance criteria
| Criterion | Status |
|---|---|
| KPI formulas unit-tested against fixtures | ✅ `tests/unit/kpi.test.js` |
| Large export completes as a job | ✅ 51-day CSV and PDF jobs run end to end against MySQL and storage (fake S3); ⏳ via the Redis worker |
| Download re-checks permission | ✅ (403 after the role is removed; queued jobs fail too) |
