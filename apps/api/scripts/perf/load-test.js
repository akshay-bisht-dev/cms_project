// Concurrent read load against a running API (docs/performance.md). No dependencies: Node fetch.
//   PERF_BASE_URL=http://127.0.0.1:4200 PERF_DURATION_S=60 PERF_CONCURRENCY=40 node scripts/perf/load-test.js
// Signs in as four seeded roles (PERF_PASSWORD) and replays a weighted mix of the busiest screens.
// Prints per-endpoint p50/p95/p99 and error counts as JSON; exits 1 when an endpoint's p95 exceeds
// PERF_P95_BUDGET_MS (default 500, the NFR) or any request fails.
const BASE = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:4200';
const DURATION_MS = Number(process.env.PERF_DURATION_S ?? 60) * 1000;
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 40);
const BUDGET_MS = Number(process.env.PERF_P95_BUDGET_MS ?? 500);
const PASSWORD = process.env.PERF_PASSWORD ?? 'Perf-Passphrase-2026';
const DOMAIN = process.env.PERF_DOMAIN ?? 'acme-it.test';

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const monday = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
})();

// [role, name, path, weight]
const MIX = [
  ['dev', 'notifications', '/notifications?limit=20', 6],
  ['dev', 'unread-count', '/notifications/unread-count', 10],
  ['dev', 'time-entries week', `/time-entries?from=${day(-7)}&to=${day(0)}`, 5],
  ['dev', 'my tasks', '/tasks?assignee=me', 4],
  ['dev', 'activity day', `/activity/day?date=${day(-1)}`, 3],
  ['dev', 'calendar month', `/calendar?from=${day(-15)}&to=${day(15)}`, 2],
  ['lead', 'team activity', `/activity/team?date=${day(-1)}`, 3],
  ['lead', 'activity week', `/activity/week?weekStart=${monday}`, 2],
  ['lead', 'timesheet approvals', '/timesheets?view=approvals', 2],
  ['owner', 'dashboard summary', '/dashboard/summary', 4],
  ['owner', 'employees page', '/employees?limit=25&sort=name', 4],
  ['owner', 'employee search', '/employees?q=perf%2012&limit=25', 2],
  ['owner', 'trends 8 weeks', '/activity/trends?weeks=8', 1],
  ['owner', 'time report 30 days', `/reports/time?from=${day(-30)}&to=${day(-1)}&groupBy=member`, 1],
  ['owner', 'projects', '/projects', 2],
  ['owner', 'audit log', '/audit-logs?limit=50', 2],
  ['hr', 'leave approvals', '/leave/requests?view=approvals', 1],
];

async function signIn(local) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${local}@${DOMAIN}`, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${local}: HTTP ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);

const cookies = { dev: await signIn('dev1'), lead: await signIn('lead'), owner: await signIn('owner'), hr: await signIn('hr') };
const weighted = MIX.flatMap((m) => Array(m[3]).fill(m));
const stats = Object.fromEntries(MIX.map(([, name]) => [name, { samples: [], errors: 0, statuses: {} }]));

// Warm-up: one pass so first-request costs (stats backfill, caches) are not counted.
for (const [role, , path] of MIX) await fetch(`${BASE}/api/v1${path}`, { headers: { cookie: cookies[role] } });

const deadline = Date.now() + DURATION_MS;
let seq = 0;
async function loop() {
  while (Date.now() < deadline) {
    const [role, name, path] = weighted[seq++ % weighted.length];
    const t = performance.now();
    try {
      const res = await fetch(`${BASE}/api/v1${path}`, { headers: { cookie: cookies[role] } });
      await res.arrayBuffer();
      const s = stats[name];
      s.samples.push(performance.now() - t);
      s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
      if (!res.ok) s.errors += 1;
    } catch {
      stats[name].errors += 1;
    }
  }
}
const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, loop));
const elapsedS = (performance.now() - started) / 1000;

const rows = Object.entries(stats).map(([name, s]) => {
  const sorted = s.samples.sort((a, b) => a - b);
  return { endpoint: name, requests: sorted.length, errors: s.errors, statuses: s.statuses, p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), p99: Math.round(percentile(sorted, 99)), max: Math.round(sorted.at(-1) ?? 0) };
});
const total = rows.reduce((n, r) => n + r.requests, 0);
const all = Object.values(stats).flatMap((s) => s.samples).sort((a, b) => a - b);
const summary = { base: BASE, concurrency: CONCURRENCY, durationS: Math.round(elapsedS), requests: total, rps: Math.round(total / elapsedS), p50: Math.round(percentile(all, 50)), p95: Math.round(percentile(all, 95)), p99: Math.round(percentile(all, 99)), errors: rows.reduce((n, r) => n + r.errors, 0), budgetMs: BUDGET_MS };
process.stdout.write(`${JSON.stringify({ summary, endpoints: rows }, null, 2)}\n`);
const over = rows.filter((r) => r.p95 > BUDGET_MS || r.errors);
if (over.length) {
  process.stderr.write(`Over budget or failing: ${over.map((r) => `${r.endpoint} (p95 ${r.p95} ms, ${r.errors} errors)`).join('; ')}\n`);
  process.exitCode = 1;
}
