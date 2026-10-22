// Builds a production-sized dataset for load tests and query review (docs/performance.md).
//   DATABASE_URL_PERF=mysql://…/orbit_perf_test node scripts/perf/generate-volume.js
// Refuses any database whose name does not end in "_perf_test". Migrates, empties and seeds it,
// then adds PERF_EMPLOYEES employees (default 300) to the seeded Acme organization and PERF_DAYS
// days (default 180) of history for everyone: time entries, activity events, tasks,
// notifications and audit entries, plus the daily stats rollup.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPrisma } from '../../src/repositories/prisma.js';
import { createMember } from '../../tests/helpers/factories.js';
import { backfillStats } from '../../src/modules/activity/stats.js';

const url = process.env.DATABASE_URL_PERF;
if (!url) throw new Error('DATABASE_URL_PERF is not set');
const dbName = new URL(url).pathname.slice(1);
if (!dbName.endsWith('_perf_test')) throw new Error(`Refusing "${dbName}": name must end with _perf_test`);
const EMPLOYEES = Number(process.env.PERF_EMPLOYEES ?? 300);
const DAYS = Number(process.env.PERF_DAYS ?? 180);
const apiDir = fileURLToPath(new URL('../../', import.meta.url));
// Load tests sign in as seeded users (owner, lead, hr, dev1) with this password.
const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', SEED_PASSWORD: process.env.SEED_PASSWORD ?? 'Perf-Passphrase-2026' };
const t0 = Date.now();
const log = (msg) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);

execFileSync(fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url)), ['migrate', 'deploy'], { cwd: apiDir, env, stdio: 'pipe' });
const prisma = createPrisma({ url, tenantGuard: false });

/** Time-ordered UUIDv7, as the app generates. */
function uuid7(ms) {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const pick = (arr, i) => arr[i % arr.length];
const sqlDate = (d) => d.toISOString().slice(0, 23).replace('T', ' ');

/** Multi-row INSERT in batches; values are passed as parameters. */
async function bulkInsert(table, columns, rows, batch = 1000) {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    await prisma.$executeRawUnsafe(`INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(',')}) VALUES ${placeholders}`, ...chunk.flat());
  }
  log(`${table}: +${rows.length.toLocaleString()}`);
}

try {
  const tables = await prisma.$queryRaw`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT IN ('_prisma_migrations', 'permissions')`;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${name}\``);
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }, { timeout: 120_000 });
  execFileSync(process.execPath, ['prisma/seed.js'], { cwd: apiDir, env, stdio: 'pipe' });
  log('seeded');

  const org = await prisma.organization.findUnique({ where: { slug: 'acme-it' } });
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { organizationId: org.id } })).map((r) => [r.key, r]));
  const eng = await prisma.department.findFirst({ where: { organizationId: org.id, code: 'ENG' } });
  const lead = await prisma.user.findUnique({ where: { email: 'lead@acme-it.test' } });
  for (let i = 0; i < EMPLOYEES; i += 1) {
    await createMember(prisma, { org, roles }, { email: `perf${i}@acme-it.test`, name: `Perf Person ${String(i).padStart(3, '0')}`, profile: { departmentId: eng?.id ?? null, managerUserId: lead.id, designation: 'Engineer' } });
  }
  await prisma.organizationMember.updateMany({ where: { organizationId: org.id }, data: { joinedAt: new Date(Date.now() - (DAYS + 30) * 86_400_000) } });
  log(`+${EMPLOYEES} employees`);

  const members = await prisma.organizationMember.findMany({ where: { organizationId: org.id, memberType: 'EMPLOYEE' }, select: { userId: true } });
  const userIds = members.map((m) => m.userId);
  const projects = await prisma.project.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const statusesByProject = {};
  for (const st of await prisma.taskStatus.findMany({ where: { organizationId: org.id }, select: { id: true, projectId: true } })) (statusesByProject[st.projectId] ??= []).push(st.id);
  if (projects.some((p) => !statusesByProject[p.id])) throw new Error('Every seeded project needs a workflow');

  // Tasks: 40 per project-member slice, spread over the seeded projects.
  const taskRows = [];
  const taskIds = [];
  const maxNumber = Object.fromEntries((await prisma.$queryRaw`SELECT project_id AS p, MAX(number) AS n FROM tasks WHERE organization_id = ${org.id} GROUP BY project_id`).map((r) => [r.p, Number(r.n)]));
  for (let i = 0; i < 20_000; i += 1) {
    const projectId = pick(projects, i).id;
    maxNumber[projectId] = (maxNumber[projectId] ?? 0) + 1;
    // Spread creation evenly over the period; due 3–30 days after creation.
    const created = Date.now() - Math.floor(((i * 7919) % 20_000) / 20_000 * DAYS * 86_400_000);
    const id = uuid7(created);
    taskIds.push({ id, projectId });
    taskRows.push([id, org.id, projectId, maxNumber[projectId], pick(statusesByProject[projectId], i), `Perf task ${i}`, pick(['LOW', 'MEDIUM', 'HIGH', 'URGENT'], i), new Date(created + (3 + (i % 28)) * 86_400_000), i, sqlDate(new Date(created)), sqlDate(new Date(created)), 0]);
  }
  await bulkInsert('tasks', ['id', 'organization_id', 'project_id', 'number', 'status_id', 'title', 'priority', 'due_date', 'sort', 'created_at', 'updated_at', 'version'], taskRows);

  // Per person and working day: three time entries, ~20 activity events.
  const time = [];
  const activity = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  for (let d = DAYS; d >= 1; d -= 1) {
    const day = new Date(start.getTime() - d * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    userIds.forEach((userId, u) => {
      let t = day.getTime() + 3.5 * 3_600_000 + (u % 60) * 60_000; // ~09:00 IST
      activity.push([uuid7(t), sqlDate(new Date(t)), org.id, userId, 'attendance.clock_in', null, null, null, null, null]);
      for (let k = 0; k < 3; k += 1) {
        const task = pick(taskIds, u * 31 + d * 3 + k);
        const len = (90 + ((u + k + d) % 90)) * 60;
        time.push([uuid7(t), org.id, userId, task.projectId, task.id, `Work ${k}`, (u + k) % 3 !== 0, sqlDate(new Date(t)), sqlDate(new Date(t + len * 1000)), len, k === 2 ? 'MANUAL' : 'TIMER', sqlDate(new Date(t)), sqlDate(new Date(t)), 0]);
        activity.push([uuid7(t + 1), sqlDate(new Date(t + 1)), org.id, userId, 'timer.started', 'task', task.id, task.projectId, null, null]);
        for (let e = 0; e < 4; e += 1) activity.push([uuid7(t + 2 + e), sqlDate(new Date(t + 600_000 * (e + 1))), org.id, userId, 'task.commented', 'task', task.id, task.projectId, null, null]);
        activity.push([uuid7(t + len * 1000), sqlDate(new Date(t + len * 1000)), org.id, userId, 'timer.stopped', 'task', task.id, task.projectId, null, null]);
        t += len * 1000 + 600_000;
      }
      activity.push([uuid7(t), sqlDate(new Date(t)), org.id, userId, 'attendance.clock_out', null, null, null, null, null]);
    });
  }
  await bulkInsert('time_entries', ['id', 'organization_id', 'user_id', 'project_id', 'task_id', 'description', 'is_billable', 'started_at', 'ended_at', 'duration_s', 'source', 'created_at', 'updated_at', 'version'], time);
  await bulkInsert('activity_events', ['id', 'occurred_at', 'organization_id', 'user_id', 'type', 'subject_type', 'subject_id', 'project_id', 'duration_s', 'metadata'], activity, 2000);

  const notifications = [];
  const audits = [];
  for (let i = 0; i < 150_000; i += 1) {
    const at = Date.now() - ((i * 104_729) % (DAYS * 86_400_000));
    notifications.push([uuid7(at), org.id, pick(userIds, i), 'task.assigned', `Notification ${i}`, null, '/tasks', `perf-${i}`, i % 4 === 0 ? null : sqlDate(new Date(at + 3_600_000)), sqlDate(new Date(at))]);
  }
  for (let i = 0; i < 300_000; i += 1) {
    const at = Date.now() - ((i * 15_485_863) % (DAYS * 86_400_000));
    audits.push([uuid7(at), sqlDate(new Date(at)), org.id, 'USER', pick(userIds, i), pick(['time.entry_updated', 'tasks.updated', 'auth.login', 'employees.updated'], i), 'task', pick(taskIds, i).id, JSON.stringify({ field: 'status' }), '10.0.0.1']);
  }
  await bulkInsert('notifications', ['id', 'organization_id', 'recipient_user_id', 'type', 'title', 'body', 'link', 'dedupe_key', 'read_at', 'created_at'], notifications);
  await bulkInsert('audit_logs', ['id', 'at', 'organization_id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'diff', 'ip'], audits, 2000);

  await prisma.$executeRawUnsafe('ANALYZE TABLE time_entries, activity_events, tasks, notifications, audit_logs');
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  await backfillStats(prisma, { organizationId: org.id, from, to: today, now: new Date() });
  log(`daily stats ${from}…${today}`);
  log('done');
} finally {
  await prisma.$disconnect();
}
