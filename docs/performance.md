# Performance: load tests and query review

**Target (NFR):** p95 under 500 ms for interactive API requests at expected load.
**Result (2026-10-22):** met at 10 concurrent users with no think time (126 requests/s, about the
traffic of a few-thousand-person organization); not met at 40 (saturation), as described below. Raw
results: [`docs/evidence/phase-11/`](evidence/phase-11/).

## Method
1. **Data.** `scripts/perf/generate-volume.js` builds `orbit_perf_test`: the seeded Acme organization
   plus 300 employees (307 in total) and 180 days of history.

   | Table | Rows |
   |---|---|
   | Activity events | 785,920 |
   | Audit entries | 300,000 |
   | Notifications | 150,000 |
   | Time entries | 117,888 |
   | Tasks | 20,000 (in two projects: deliberately heavy) |
   | Daily member stats | 60 days, rolled up |

2. **Server.** The API runs with `NODE_ENV=production`, one process, a pool of 20 connections, rate
   limits off for the generator, and a local MySQL 8.4 with a 128 MB buffer pool.
3. **Load.** `scripts/perf/load-test.js` signs in as four roles and replays a weighted mix of 17 busy
   screens (dashboard, people, time, activity, reports, calendar, notifications, audit log…) with no
   think time. The first pass of each endpoint is a warm-up and is not counted.
4. **Diagnosis.** `scripts/perf/query-profile.js` calls endpoints in-process and prints the number of
   queries, the time spent in SQL and every statement over a threshold. MySQL's `performance_schema`
   (digests and prepared statements) ranks statements by total time and rows examined vs. sent.

```bash
DATABASE_URL_PERF=mysql://…/orbit_perf_test node apps/api/scripts/perf/generate-volume.js
# start the API against orbit_perf_test with RATE_LIMIT_ENABLED=false, then:
PERF_BASE_URL=http://127.0.0.1:4200 PERF_CONCURRENCY=10 PERF_DURATION_S=60 node apps/api/scripts/perf/load-test.js
node apps/api/scripts/perf/query-profile.js owner@acme-it.test /activity/trends?weeks=8
```

## Findings and fixes
| Finding | Evidence | Fix |
|---|---|---|
| Dashboard "tracked today" scanned every time entry of the organization | 117,888 rows examined, 0 returned, ~850 ms | Index `time_entries(organization_id, started_at)` (migration `…120000`) |
| Interval queries had no lower bound | ~320 rows (a member's whole history) examined per member-day | `overlapping()` in `utils/time.js`: a 7-day lookback, exact because finished entries and sessions last ≤ 24 h. Used by the rollup, activity views and reports |
| "Today" was recomputed for every member on every read | 7,200 transactions during a read-only load | Today is reused for 60 s. Above 25 people, stale rows are served and refreshed in the background (`stats.refresh` job) |
| Synchronous stats budget exceeded the request timeout | 1,500 member-days × ~13–16 ms ≈ 24 s > 15 s | Also capped at 2.5 s of work; the rest goes to the background backfill (the UI says figures are incomplete) |
| N+1 on time zones | Trends: 3,261 queries; time report: 1,856 | `memberZones()` resolves everyone's zone in 5 queries (same precedence as `memberCalendar`, tested for equality) |
| Reports loaded every person-day into the app | 17,192 rows hydrated by Prisma (~700 ms) | `aggregateStats()` and `trackedTimeByProject()` aggregate in SQL. The KPI formulas are unchanged (`summarize` split into accumulate/merge/finish); a randomized equality test compares SQL with the JS original |
| Stats gap check read every key row | 17,192 rows (~300 ms) | A count per person; dates are fetched only for people with gaps |

Tested and **rejected:** an index `tasks(organization_id, project_id, due_date)` for the calendar and
dashboard deadlines. The optimizer did not use it (same timings), so no migration was added.

## Results
| Endpoint (p95, ms) | Before, 4 users | After, 10 users | After, 40 users |
|---|---|---|---|
| Activity trends (8 weeks, 307 people) | 9,190 | 449 | 1,082 |
| Time report (30 days, by member) | 2,452 | 271 | 695 |
| Dashboard summary | 1,195 | 350 | 779 |
| Calendar (month) | 405 | 306 | 714 |
| Projects | 199 | 252 | 723 |
| Team activity | 35 | 31 | 329 |
| Employees (page of 25) | 37 | 51 | 190 |
| Notifications | 28 | 23 | 209 |
| **All requests** | p95 1,160 · p99 8,526 | **p95 334 · p99 414** | p95 719 · p99 1,004 |
| Throughput / errors | 11 req/s · 0 | 126 req/s · 0 | 140 req/s · 0 |

At 40 concurrent users one API process is CPU-bound: even the trivial unread-count endpoint queues,
taking 9 ms alone and 110 ms under that load. Production runs at least two API replicas behind an
autoscaler (CPU target 65 %). 40 users with no think time is far heavier than 40 real people.

## Known limits
- The remaining 150–300 ms on dashboard, calendar and projects comes from task queries. Prisma's
  relation filters become `LEFT JOIN … OR EXISTS` that MySQL drives from the project, so they scale
  with tasks per project. The test data has 10,000 tasks per project and ~9,000 open overdue tasks;
  real projects are far smaller.
- Measured on one machine with a small buffer pool; production MySQL should hold the hot indexes in memory.
- The worker side (rollups, screenshot processing, report exports) was profiled through the same
  functions, not load-tested as a queue under Redis.
