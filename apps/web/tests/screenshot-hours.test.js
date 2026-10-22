import { describe, expect, it } from 'vitest';
import { buildHours } from '@/features/monitoring/screenshot-timeline';

const base = {
  window: { start: '2026-10-21T00:00:00.000Z', end: '2026-10-22T00:00:00.000Z' },
  monitoring: { enabled: true, intervalS: 600 },
  agents: [{ status: 'ACTIVE' }],
  sessions: [{ startedAt: '2026-10-21T09:00:00.000Z', endedAt: '2026-10-21T13:00:00.000Z', breaks: [{ startedAt: '2026-10-21T11:00:00.000Z', endedAt: '2026-10-21T12:00:00.000Z' }] }],
  screenshots: [
    { id: 'a', capturedAt: '2026-10-21T09:05:00.000Z', status: 'READY' },
    { id: 'b', capturedAt: '2026-10-21T10:30:00.000Z', status: 'FAILED', failureCode: 'EXPIRED' },
  ],
};
const now = Date.parse('2026-10-21T18:00:00.000Z');

describe('buildHours', () => {
  it('lists only working hours or hours with captures, and explains each gap', () => {
    const hours = buildHours(base, now);
    expect(hours.map((h) => new Date(h.start).toISOString().slice(11, 13))).toEqual(['09', '10', '11', '12']);
    expect(hours[0].shots.map((s) => s.id)).toEqual(['a']);
    expect(hours[1].shots.map((s) => s.id)).toEqual(['b']); // a failed capture is shown, not hidden
    expect(hours[2].gap.text).toBe('On a break');
    expect(hours[3].gap.text).toMatch(/offline or paused/);
  });

  it('says why nothing was captured when monitoring is off or no device is connected', () => {
    const quiet = { ...base, screenshots: [] };
    expect(buildHours({ ...quiet, monitoring: { enabled: false } }, now)[0].gap.text).toMatch(/not enabled/);
    expect(buildHours({ ...quiet, agents: [{ status: 'REVOKED' }] }, now)[0].gap.text).toBe('No desktop app connected');
  });

  it('does not list future hours of an open session', () => {
    const open = { ...base, screenshots: [], sessions: [{ startedAt: '2026-10-21T09:00:00.000Z', endedAt: null, breaks: [] }] };
    expect(buildHours(open, Date.parse('2026-10-21T10:30:00.000Z'))).toHaveLength(2);
  });

  it('follows instants on DST days (25 hours on the fall-back day)', () => {
    const fallBack = { ...base, window: { start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' }, sessions: [{ startedAt: '2026-11-01T04:00:00.000Z', endedAt: '2026-11-02T05:00:00.000Z', breaks: [] }], screenshots: [] };
    expect(buildHours(fallBack, Date.parse('2026-11-03T00:00:00.000Z'))).toHaveLength(25);
  });
});
