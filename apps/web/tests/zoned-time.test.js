import { describe, expect, it } from 'vitest';
import { isoToZonedInput, zonedInputToIso } from '@/lib/zoned-time';
import { formatDuration, weekOf } from '@/lib/format';

describe('zoned time inputs', () => {
  it('converts wall-clock input in a zone to UTC, on both sides of a DST change', () => {
    expect(zonedInputToIso('2026-10-21T09:00', 'Asia/Kolkata')).toBe('2026-10-21T03:30:00.000Z');
    expect(zonedInputToIso('2026-03-07T09:00', 'America/New_York')).toBe('2026-03-07T14:00:00.000Z');
    expect(zonedInputToIso('2026-03-08T09:00', 'America/New_York')).toBe('2026-03-08T13:00:00.000Z');
  });

  it('round-trips instants back to inputs', () => {
    const iso = '2026-11-01T14:45:00.000Z';
    const { local } = isoToZonedInput(iso, 'America/New_York');
    expect(local).toBe('2026-11-01T09:45');
    expect(zonedInputToIso(local, 'America/New_York')).toBe(iso);
  });
});

describe('time formatting', () => {
  it('formats durations and weeks', () => {
    expect(formatDuration(27000)).toBe('7h 30m');
    expect(formatDuration(59)).toBe('0m');
    expect(formatDuration(3725, { showSeconds: true })).toBe('01:02:05');
    expect(formatDuration(-5)).toBe('0m');
    expect(weekOf('2026-10-21')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(weekOf('2026-10-25')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });
});
