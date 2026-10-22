export function formatDate(value, { timeZone, withTime = false } = {}) {
  if (!value) return '—';
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    // Date-only values are calendar dates: render them in UTC so they never shift a day.
    timeZone: typeof value === 'string' && value.length === 10 ? 'UTC' : timeZone,
  }).format(date);
}

const UNITS = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

export function formatRelative(value, now = Date.now()) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

export const MEMBER_STATUS_LABEL = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
  ARCHIVED: 'Archived',
};

export const EMPLOYMENT_TYPE_LABEL = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contractor', INTERN: 'Intern' };

/** 27000 → "7h 30m"; negative or missing → "0m". */
export function formatDuration(seconds, { showSeconds = false } = {}) {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (showSeconds) return [h, m, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Decimal hours for tables and exports: 27000 → "7.50". */
export const formatHours = (seconds) => ((seconds ?? 0) / 3600).toFixed(2);

export function formatTime(value, timeZone) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value));
}

export function formatWeekday(isoDate) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** ISO date (YYYY-MM-DD) of "today" in a time zone. */
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday-based week containing an ISO date (display only; timesheet periods come from the API). */
export function weekOf(isoDate, weekStart = 1) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const start = addDays(isoDate, -((weekday - weekStart + 7) % 7));
  return { from: start, to: addDays(start, 6) };
}

/**
 * Money arrives from the API as exact decimal strings; this only formats for display (rounding
 * to the currency's minor units, as the API already did).
 */
export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}
