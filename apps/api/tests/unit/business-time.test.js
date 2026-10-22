import { describe, expect, it } from 'vitest';
import { addBusinessMinutes } from '../../src/utils/business-time.js';

const schedule = { days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) };
const at = (iso) => new Date(iso);

describe('business minutes', () => {
  it('adds plain minutes without a schedule', () => {
    expect(addBusinessMinutes(at('2026-10-23T16:00:00Z'), 120)).toEqual(at('2026-10-23T18:00:00Z'));
  });

  it('counts only working hours and skips weekends', () => {
    // Friday 16:00 + 2 h → 1 h on Friday, 1 h on Monday.
    expect(addBusinessMinutes(at('2026-10-23T16:00:00Z'), 120, { schedule })).toEqual(at('2026-10-26T10:00:00Z'));
    // Before opening: starts counting at 09:00.
    expect(addBusinessMinutes(at('2026-10-21T06:00:00Z'), 60, { schedule })).toEqual(at('2026-10-21T10:00:00Z'));
    // After closing: next working day.
    expect(addBusinessMinutes(at('2026-10-21T20:00:00Z'), 30, { schedule })).toEqual(at('2026-10-22T09:30:00Z'));
  });

  it('skips holidays and respects the zone', () => {
    expect(addBusinessMinutes(at('2026-10-23T16:00:00Z'), 120, { schedule, holidays: ['2026-10-26'] })).toEqual(at('2026-10-27T10:00:00Z'));
    // 09:00 in Kolkata is 03:30 UTC.
    expect(addBusinessMinutes(at('2026-10-21T00:00:00Z'), 60, { schedule, zone: 'Asia/Kolkata' })).toEqual(at('2026-10-21T04:30:00Z'));
  });
});
