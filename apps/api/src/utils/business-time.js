import { DateTime } from 'luxon';
import { scheduleWindow } from './time.js';

const MAX_DAYS = 366;

/**
 * Adds `minutes` of business time to `start`: only time inside the schedule's daily window counts,
 * and holidays (ISO dates) are skipped. Without a schedule, plain elapsed minutes are added.
 * DST-safe: windows are computed per local date.
 */
export function addBusinessMinutes(start, minutes, { schedule, zone = 'UTC', holidays = [] } = {}) {
  if (!schedule) return new Date(start.getTime() + minutes * 60_000);
  const off = new Set(holidays);
  let remaining = minutes * 60_000;
  let day = DateTime.fromJSDate(start, { zone }).startOf('day');
  for (let i = 0; i < MAX_DAYS; i += 1, day = day.plus({ days: 1 })) {
    const date = day.toISODate();
    if (off.has(date)) continue;
    const window = scheduleWindow(schedule, date, zone);
    if (!window) continue;
    const from = Math.max(window.start.getTime(), start.getTime());
    const available = window.end.getTime() - from;
    if (available <= 0) continue;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
  }
  throw new Error('The schedule has no working time within a year');
}
