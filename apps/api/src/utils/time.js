import { DateTime } from 'luxon';

// Calendar rules (docs/architecture.md §7):
// - Instants are stored in UTC; local dates and schedules are evaluated in the member's IANA zone.
// - Work date = local date on which a session starts. Overnight sessions belong to that date.
// - Schedule times are local wall-clock times. A time that does not exist (DST gap) shifts forward;
//   an ambiguous time (DST overlap) uses the earlier offset. Durations always come from instants,
//   so a 23- or 25-hour day is measured exactly.

export function isValidTimeZone(zone) {
  return Boolean(zone) && DateTime.local().setZone(zone).isValid;
}

/** The member's effective zone: profile zone, else organization zone, else UTC. */
/**
 * Read-side filter for time entries and work sessions overlapping [start, end). Finished intervals last
 * at most 24 h (manual entries are validated; sessions are auto-closed at maxSessionHours ≤ 24), so a
 * week's lookback keeps this an index range instead of a scan of the member's whole history. A timer
 * left running longer is still found once it closes (its days are marked dirty and recomputed).
 * Write-side overlap validation stays unbounded, where exactness matters more than a few rows.
 */
export const INTERVAL_LOOKBACK_MS = 7 * 86_400_000;
export function overlapping(start, end) {
  return { startedAt: { gte: new Date(start.getTime() - INTERVAL_LOOKBACK_MS), lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] };
}

export function memberTimeZone(profileZone, organizationZone) {
  if (isValidTimeZone(profileZone)) return profileZone;
  if (isValidTimeZone(organizationZone)) return organizationZone;
  return 'UTC';
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(instant, zone) {
  return DateTime.fromJSDate(instant, { zone }).toISODate();
}

/** ISO date string → JS Date at UTC midnight (how MySQL DATE columns round-trip through Prisma). */
export function dateOnly(isoDate) {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** [start, end) instants covering whole local dates fromDate..toDate inclusive. */
export function localDateRange(fromDate, toDate, zone) {
  const start = DateTime.fromISO(fromDate, { zone }).startOf('day');
  const end = DateTime.fromISO(toDate, { zone }).plus({ days: 1 }).startOf('day');
  return [start.toJSDate(), end.toJSDate()];
}

function parseClock(text) {
  const [hour, minute] = String(text).split(':').map(Number);
  return { hour, minute };
}

/**
 * Expected working window for one local date, or null when the schedule has no hours that day.
 * days: [{ weekday: 1-7 (Mon-Sun), start: "HH:MM", end: "HH:MM" }].
 */
export function scheduleWindow(schedule, date, zone) {
  if (!schedule) return null;
  const day = DateTime.fromISO(date, { zone });
  const spec = (schedule.days ?? []).find((d) => d.weekday === day.weekday);
  if (!spec) return null;
  const startClock = parseClock(spec.start);
  const endClock = parseClock(spec.end);
  const start = day.set({ ...startClock, second: 0, millisecond: 0 });
  let end = day.set({ ...endClock, second: 0, millisecond: 0 });
  if (endClock.hour * 60 + endClock.minute <= startClock.hour * 60 + startClock.minute) end = end.plus({ days: 1 });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    // Actual elapsed seconds between the instants (DST-correct), unless a fixed requirement is set.
    expectedS: schedule.requiredMinutesPerDay ? schedule.requiredMinutesPerDay * 60 : Math.round(end.diff(start, 'seconds').seconds),
  };
}

/**
 * Timesheet period containing a local date.
 * WEEKLY uses the organization's week start (ISO weekday); BIWEEKLY is anchored at 2024-01-01
 * shifted to that week start; SEMIMONTHLY is 1st–15th and 16th–end of month.
 */
export function periodFor(date, period, weekStart = 1) {
  const day = DateTime.fromISO(date, { zone: 'UTC' });
  const weekStartOf = (d) => d.minus({ days: (d.weekday - weekStart + 7) % 7 });
  switch (period) {
    case 'DAILY':
      return { start: day.toISODate(), end: day.toISODate() };
    case 'WEEKLY': {
      const start = weekStartOf(day);
      return { start: start.toISODate(), end: start.plus({ days: 6 }).toISODate() };
    }
    case 'BIWEEKLY': {
      const anchor = weekStartOf(DateTime.fromISO('2024-01-01', { zone: 'UTC' }));
      const weeks = Math.floor(weekStartOf(day).diff(anchor, 'weeks').weeks);
      const start = anchor.plus({ weeks: weeks - (((weeks % 2) + 2) % 2) });
      return { start: start.toISODate(), end: start.plus({ days: 13 }).toISODate() };
    }
    case 'SEMIMONTHLY':
      return day.day <= 15
        ? { start: day.set({ day: 1 }).toISODate(), end: day.set({ day: 15 }).toISODate() }
        : { start: day.set({ day: 16 }).toISODate(), end: day.endOf('month').toISODate() };
    default:
      throw new Error(`Unknown timesheet period "${period}"`);
  }
}

export const secondsBetween = (a, b) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
