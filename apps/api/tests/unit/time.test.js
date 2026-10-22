import { describe, expect, it } from 'vitest';
import { localDate, localDateRange, memberTimeZone, periodFor, scheduleWindow } from '../../src/utils/time.js';

const NY = 'America/New_York';
const weekdays = (start, end) => ({ days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start, end })) });

describe('work dates', () => {
  it('uses the local date of the zone, not UTC', () => {
    expect(localDate(new Date('2026-03-09T03:30:00Z'), NY)).toBe('2026-03-08');
    expect(localDate(new Date('2026-03-09T03:30:00Z'), 'Asia/Kolkata')).toBe('2026-03-09');
  });

  it('falls back from invalid profile zones to the organization zone, then UTC', () => {
    expect(memberTimeZone('Mars/Base', 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(memberTimeZone(null, null)).toBe('UTC');
    expect(memberTimeZone('Europe/London', 'Asia/Kolkata')).toBe('Europe/London');
  });

  it('builds [start, end) instants for local date ranges across a DST change', () => {
    const [start, end] = localDateRange('2026-03-08', '2026-03-08', NY);
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // 23-hour day
  });
});

describe('schedule windows', () => {
  it('computes a normal 9-to-6 day', () => {
    const w = scheduleWindow(weekdays('09:00', '18:00'), '2026-10-21', 'Asia/Kolkata');
    expect(w.start.toISOString()).toBe('2026-10-21T03:30:00.000Z');
    expect(w.expectedS).toBe(9 * 3600);
  });

  it('extends overnight shifts into the next day', () => {
    const w = scheduleWindow(weekdays('22:00', '06:00'), '2026-10-21', 'UTC');
    expect(w.start.toISOString()).toBe('2026-10-21T22:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(w.expectedS).toBe(8 * 3600);
  });

  it('measures an overnight shift across spring-forward as 7 real hours', () => {
    const w = scheduleWindow(weekdays('22:00', '06:00'), '2026-03-07', NY);
    expect(w.expectedS).toBe(7 * 3600);
  });

  it('measures an overnight shift across fall-back as 9 real hours', () => {
    const w = scheduleWindow(weekdays('22:00', '06:00'), '2026-10-31', NY);
    expect(w.expectedS).toBe(9 * 3600);
  });

  it('shifts a start inside the DST gap forward and uses the earlier offset in the overlap', () => {
    expect(scheduleWindow(weekdays('02:30', '10:00'), '2026-03-08', NY).start.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(scheduleWindow(weekdays('01:30', '09:00'), '2026-11-01', NY).start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('returns null on days without hours and honours a fixed daily requirement', () => {
    const mondayOnly = { days: [{ weekday: 1, start: '09:00', end: '17:00' }], requiredMinutesPerDay: 420 };
    expect(scheduleWindow(mondayOnly, '2026-10-21', 'UTC')).toBeNull(); // Wednesday
    expect(scheduleWindow(mondayOnly, '2026-10-19', 'UTC').expectedS).toBe(420 * 60);
  });
});

describe('timesheet periods', () => {
  it('weekly respects the organization week start', () => {
    expect(periodFor('2026-10-21', 'WEEKLY', 1)).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(periodFor('2026-10-21', 'WEEKLY', 7)).toEqual({ start: '2026-10-18', end: '2026-10-24' });
  });

  it('semi-monthly splits on the 15th and ends on the last day', () => {
    expect(periodFor('2026-02-20', 'SEMIMONTHLY')).toEqual({ start: '2026-02-16', end: '2026-02-28' });
    expect(periodFor('2026-02-15', 'SEMIMONTHLY')).toEqual({ start: '2026-02-01', end: '2026-02-15' });
  });

  it('bi-weekly periods are stable and contiguous', () => {
    const a = periodFor('2026-10-21', 'BIWEEKLY');
    const b = periodFor(a.end, 'BIWEEKLY');
    expect(b).toEqual(a);
    const dayAfter = (iso) => new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);
    const next = periodFor(dayAfter(a.end), 'BIWEEKLY');
    expect(next.start).toBe(dayAfter(a.end));
    expect((Date.parse(next.end) - Date.parse(next.start)) / 86_400_000).toBe(13);
    expect(periodFor('2026-10-21', 'DAILY')).toEqual({ start: '2026-10-21', end: '2026-10-21' });
  });
});
