import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { INTERVAL_LOOKBACK_MS, dateOnly, isoDate, localDate } from '../../utils/time.js';
import { enqueueOutbox } from '../../services/outbox.js';
import { memberZones } from '../attendance/schedule.js';
import { processDirtyStats, recomputeMemberDays } from './rollup.js';
import { emptyTotals } from './kpi.js';

/** Member-days a synchronous request may compute before it must defer to a background job. */
export const SYNC_COMPUTE_BUDGET = 1500;
/** Wall-clock limit for that work (a member-day costs ~10–20 ms), well inside the request timeout. */
export const SYNC_COMPUTE_MS = 2500;
/** Today's row is reused for this long; changes since mark the day dirty and are rebuilt anyway. */
export const TODAY_FRESH_MS = 60_000;
/**
 * Up to this many people, a stale "today" is rebuilt inside the request (personal and team views stay
 * live). Above it the stored row (at most a minute or two old) is served and a background refresh is
 * queued, so an organization-wide screen never rebuilds hundreds of member-days on a read.
 */
export const SYNC_TODAY_LIMIT = 25;

/** Every calendar date from `from` to `to` inclusive (ISO strings). */
export function datesBetween(from, to) {
  const out = [];
  for (let d = DateTime.fromISO(from, { zone: 'UTC' }); d.toISODate() <= to; d = d.plus({ days: 1 })) out.push(d.toISODate());
  return out;
}

/**
 * Makes daily stats for `userIds` × `dates` current before they are read:
 *   1. rebuilds days marked dirty by recent changes,
 *   2. refreshes "today" (still changing, e.g. a running timer) once its row is over a minute old:
 *      inline for up to SYNC_TODAY_LIMIT people, otherwise in the background,
 *   3. computes days that were never computed (e.g. before activity tracking existed),
 * within `budget` member-days and `timeBudgetMs`. Returns { complete } — when false, a background
 * backfill has been queued and the caller should say the figures are incomplete.
 */
export async function ensureStats(prisma, { organizationId, userIds, dates, now, budget = SYNC_COMPUTE_BUDGET, timeBudgetMs = SYNC_COMPUTE_MS, syncTodayLimit = SYNC_TODAY_LIMIT }) {
  const startedAt = Date.now();
  if (!userIds.length || !dates.length) return { complete: true, computed: 0 };
  await processDirtyStats(prisma, { now, organizationId, userIds });

  // Which person-days exist, without reading every row: a count per person, then dates only for
  // people with gaps, and the rows for "today" (one or two dates, depending on time zones).
  const range = { organizationId, userId: { in: userIds }, date: { gte: dateOnly(dates[0]), lte: dateOnly(dates.at(-1)) } };
  const [zones, counts] = await Promise.all([
    memberZones(prisma, organizationId, userIds),
    prisma.dailyMemberStat.groupBy({ by: ['userId'], where: range, _count: { _all: true } }),
  ]);
  const todayOf = new Map(userIds.map((id) => [id, localDate(now, zones.get(id))]));
  const countOf = new Map(counts.map((c) => [c.userId, c._count._all]));
  const short = userIds.filter((id) => (countOf.get(id) ?? 0) < dates.filter((d) => d <= todayOf.get(id)).length);
  const withGaps = new Set(short);
  const todays = [...new Set(todayOf.values())].filter((d) => d >= dates[0] && d <= dates.at(-1));
  const [gapRows, todayRows] = await Promise.all([
    short.length ? prisma.dailyMemberStat.findMany({ where: { ...range, userId: { in: short } }, select: { userId: true, date: true } }) : [],
    todays.length ? prisma.dailyMemberStat.findMany({ where: { organizationId, userId: { in: userIds }, date: { in: todays.map(dateOnly) } }, select: { userId: true, date: true, computedAt: true } }) : [],
  ]);
  const keyOf = (r) => `${r.userId}|${isoDate(r.date)}`;
  const gapHave = new Set(gapRows.map(keyOf));
  const todayHave = new Set(todayRows.map(keyOf));
  const fresh = new Set(todayRows.filter((r) => now - r.computedAt < TODAY_FRESH_MS).map(keyOf));
  // A person without gaps has every past day; otherwise consult their fetched dates.
  const has = (userId, d) => (d === todayOf.get(userId) ? todayHave.has(`${userId}|${d}`) : !withGaps.has(userId) || gapHave.has(`${userId}|${d}`));
  const inlineToday = userIds.length <= syncTodayLimit;
  const staleToday = [];
  let computed = 0;
  let complete = true;
  for (const userId of userIds) {
    const today = todayOf.get(userId);
    const todo = [];
    for (const d of dates) {
      if (d > today) continue;
      const key = `${userId}|${d}`;
      if (d !== today) {
        if (!has(userId, d)) todo.push(d);
      } else if (!has(userId, d) || (!fresh.has(key) && inlineToday)) {
        todo.push(d);
      } else if (!fresh.has(key)) {
        staleToday.push(userId);
      }
    }
    if (computed + todo.length > budget || (todo.length && Date.now() - startedAt > timeBudgetMs)) {
      complete = false;
      break;
    }
    if (todo.length) await recomputeMemberDays(prisma, organizationId, userId, todo, now);
    computed += todo.length;
  }
  if (staleToday.length) {
    // At most one refresh per organization per minute (dedupe key), whoever asks.
    await enqueueOutbox(prisma, {
      type: 'stats.refresh',
      payload: { organizationId, userIds: staleToday },
      dedupeKey: `stats-refresh:${organizationId}:${now.toISOString().slice(0, 16)}`,
      organizationId,
    });
  }
  if (!complete) {
    // One backfill per organization per hour is plenty; the dedupe key makes this idempotent.
    await enqueueOutbox(prisma, {
      type: 'stats.backfill',
      payload: { organizationId, from: dates[0], to: dates.at(-1) },
      dedupeKey: `stats-backfill:${organizationId}:${dates[0]}:${dates.at(-1)}:${now.toISOString().slice(0, 13)}`,
      organizationId,
    });
  }
  return { complete, computed, refreshing: staleToday.length };
}

/** Background refresh of "today" for members whose row has gone stale (queued by ensureStats). */
export async function refreshTodayStats(prisma, { organizationId, userIds, now }) {
  const zones = await memberZones(prisma, organizationId, userIds);
  for (const userId of userIds) await recomputeMemberDays(prisma, organizationId, userId, [localDate(now, zones.get(userId))], now);
  return { refreshed: userIds.length };
}

/** Background backfill: computes every missing member-day of an organization in a range. */
export async function backfillStats(prisma, { organizationId, from, to, now }) {
  const members = await prisma.organizationMember.findMany({ where: { organizationId, memberType: 'EMPLOYEE', status: { in: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] } }, select: { userId: true } });
  return ensureStats(prisma, { organizationId, userIds: members.map((m) => m.userId), dates: datesBetween(from, to), now, budget: Number.MAX_SAFE_INTEGER, timeBudgetMs: Number.POSITIVE_INFINITY, syncTodayLimit: Number.POSITIVE_INFINITY });
}

/**
 * The same totals as kpi.summarize, computed by the database: an organization-wide report reads a
 * handful of aggregate rows instead of every person-day. `by`: 'date' | 'user' | null (one total).
 * Returns Map(key → totals) for kpi.finishTotals / kpi.mergeTotals; key is an ISO date, a user id or 'all'.
 */
export async function aggregateStats(db, { organizationId, userIds, from, to, by = null }) {
  if (!userIds.length) return new Map();
  const key = by === 'date' ? Prisma.sql`DATE_FORMAT(date, '%Y-%m-%d')` : by === 'user' ? Prisma.sql`user_id` : Prisma.sql`'all'`;
  const rows = await db.$queryRaw`
    SELECT ${key} AS k,
      COUNT(*) AS days,
      SUM(scheduled_s > 0) AS scheduledDays,
      SUM(status = 'PRESENT') AS presentDays,
      SUM(status = 'ABSENT') AS absentDays,
      SUM(late_by_s > 0) AS lateDays,
      SUM(scheduled_s > 0 AND status = 'PRESENT') AS presentScheduled,
      SUM(scheduled_s) AS scheduledS, SUM(worked_s) AS workedS, SUM(break_s) AS breakS, SUM(overtime_s) AS overtimeS,
      SUM(tracked_s) AS trackedS, SUM(billable_s) AS billableS, SUM(idle_s) AS idleS, SUM(monitored_s) AS monitoredS,
      SUM(screenshots_expected) AS screenshotsExpected, SUM(screenshots_ok) AS screenshotsOk,
      SUM(screenshots_failed) AS screenshotsFailed, SUM(tasks_completed) AS tasksCompleted
    FROM daily_member_stats
    WHERE organization_id = ${organizationId} AND user_id IN (${Prisma.join(userIds)})
      AND date >= ${dateOnly(from)} AND date <= ${dateOnly(to)}
    GROUP BY k`;
  const out = new Map();
  for (const r of rows) {
    const t = emptyTotals();
    for (const k of Object.keys(t)) t[k] = Number(r[k] ?? 0);
    out.set(String(r.k), t);
  }
  return out;
}

/**
 * kpi.trackedTime computed by the database: per project, time clipped to [start, end) (running
 * entries until `now`), floored to whole seconds per entry exactly as kpi.clipSeconds does. Only
 * projects with time in the window are returned. `people` counts everyone with an overlapping entry.
 */
export async function trackedTimeByProject(db, { organizationId, userIds, projectIds, start, end, now }) {
  if (!userIds.length || (projectIds && !projectIds.length)) return { trackedS: 0, billableS: 0, people: 0, byProject: [] };
  const lookback = new Date(start.getTime() - INTERVAL_LOOKBACK_MS);
  const clip = Prisma.sql`GREATEST(0, FLOOR(TIMESTAMPDIFF(MICROSECOND, GREATEST(started_at, ${start}), LEAST(COALESCE(ended_at, ${now}), ${end})) / 1000000))`;
  const where = Prisma.sql`organization_id = ${organizationId} AND user_id IN (${Prisma.join(userIds)}) AND deleted_at IS NULL
    ${projectIds ? Prisma.sql`AND project_id IN (${Prisma.join(projectIds)})` : Prisma.empty}
    AND started_at >= ${lookback} AND started_at < ${end} AND (ended_at IS NULL OR ended_at > ${start})`;
  const [rows, [overall]] = await Promise.all([
    db.$queryRaw`SELECT project_id AS projectId, SUM(${clip}) AS trackedS, SUM(IF(is_billable, ${clip}, 0)) AS billableS, COUNT(DISTINCT user_id) AS people
      FROM time_entries WHERE ${where} GROUP BY project_id HAVING SUM(${clip}) > 0`,
    db.$queryRaw`SELECT COUNT(DISTINCT user_id) AS people FROM time_entries WHERE ${where}`,
  ]);
  const byProject = rows.map((r) => ({ projectId: r.projectId ?? null, trackedS: Number(r.trackedS), billableS: Number(r.billableS), people: Number(r.people) }));
  return {
    trackedS: byProject.reduce((n, p) => n + p.trackedS, 0),
    billableS: byProject.reduce((n, p) => n + p.billableS, 0),
    people: Number(overall.people),
    byProject,
  };
}
