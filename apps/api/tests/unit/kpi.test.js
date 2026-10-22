import { describe, expect, it } from 'vitest';
import {
  attendanceRate,
  clipSeconds,
  consentWindows,
  coverage,
  expectedCaptures,
  failureRate,
  intersectIntervals,
  mergeIntervals,
  overtime,
  subtractIntervals,
  summarize,
  totalSeconds,
  trackedTime,
  utilization,
  workTime,
} from '../../src/modules/activity/kpi.js';
import { localDateRange } from '../../src/utils/time.js';

const t = (hhmm, day = '2026-10-21') => new Date(`${day}T${hhmm}:00.000Z`);
const H = 3600;

describe('interval arithmetic', () => {
  it('clips to a window', () => {
    expect(clipSeconds(t('08:00'), t('10:00'), t('09:00'), t('17:00'))).toBe(1 * H);
    expect(clipSeconds(t('18:00'), t('19:00'), t('09:00'), t('17:00'))).toBe(0);
  });

  it('merges, subtracts and intersects', () => {
    expect(mergeIntervals([{ start: t('09:00'), end: t('10:00') }, { start: t('09:30'), end: t('11:00') }])).toEqual([{ start: t('09:00'), end: t('11:00') }]);
    expect(totalSeconds(subtractIntervals([{ start: t('09:00'), end: t('17:00') }], [{ start: t('12:00'), end: t('13:00') }]))).toBe(7 * H);
    expect(totalSeconds(intersectIntervals([{ start: t('09:00'), end: t('12:00') }], [{ start: t('11:00'), end: t('14:00') }]))).toBe(1 * H);
  });
});

describe('worked and break time (measured)', () => {
  it('subtracts breaks, clips breaks to their session, and runs open sessions until now', () => {
    const sessions = [
      { startedAt: t('09:00'), endedAt: t('13:00'), breaks: [{ startedAt: t('11:00'), endedAt: t('11:30') }] },
      // A break left open is closed by the session end.
      { startedAt: t('14:00'), endedAt: t('16:00'), breaks: [{ startedAt: t('15:30'), endedAt: null }] },
      { startedAt: t('17:00'), endedAt: null, breaks: [] },
    ];
    const { workedS, breakS } = workTime(sessions, t('18:00'));
    expect(breakS).toBe(1 * H);
    expect(workedS).toBe(3.5 * H + 1.5 * H + 1 * H);
  });
});

describe('tracked time (measured)', () => {
  it('clips entries to the day, counts running timers until now, and splits by project', () => {
    const window = { start: t('00:00'), end: t('00:00', '2026-10-22') };
    const entries = [
      { startedAt: t('22:00', '2026-10-20'), endedAt: t('01:00'), isBillable: true, projectId: 'p1' }, // 1 h inside the day
      { startedAt: t('09:00'), endedAt: t('11:00'), isBillable: false, projectId: null },
      { startedAt: t('23:00'), endedAt: null, isBillable: true, projectId: 'p1' }, // running; now is next day 00:30
    ];
    const r = trackedTime(entries, window, t('00:30', '2026-10-22'));
    expect(r.trackedS).toBe(1 * H + 2 * H + 1 * H);
    expect(r.billableS).toBe(2 * H);
    expect(r.byProject).toEqual(expect.arrayContaining([{ projectId: 'p1', trackedS: 2 * H, billableS: 2 * H }, { projectId: null, trackedS: 2 * H, billableS: 0 }]));
  });

  it('uses real elapsed time across a DST change (25-hour local day)', () => {
    const [start, end] = localDateRange('2026-11-01', '2026-11-01', 'America/New_York');
    const r = trackedTime([{ startedAt: start, endedAt: end, isBillable: false }], { start, end }, end);
    expect(r.trackedS).toBe(25 * H);
  });
});

describe('screenshot coverage (derived)', () => {
  it('counts monitored time only while an acknowledgement was in force', () => {
    const windows = consentWindows(
      [
        { action: 'ACKNOWLEDGED', createdAt: t('08:00') },
        { action: 'WITHDRAWN', createdAt: t('12:00') },
        { action: 'ACKNOWLEDGED', createdAt: t('14:00') },
      ],
      t('20:00'),
    );
    expect(windows).toEqual([{ start: t('08:00'), end: t('12:00') }, { start: t('14:00'), end: t('20:00') }]);
    const worked = [{ start: t('09:00'), end: t('17:00') }];
    const monitoredS = totalSeconds(intersectIntervals(worked, windows));
    expect(monitoredS).toBe(3 * H + 3 * H);
    expect(expectedCaptures(monitoredS, 600)).toBe(36);
    expect(expectedCaptures(599, 600)).toBe(0);
    expect(expectedCaptures(monitoredS, null)).toBe(0);
  });

  it('caps coverage at 100 % and has no value without expectations', () => {
    expect(coverage(30, 36)).toBeCloseTo(0.8333, 4);
    expect(coverage(40, 36)).toBe(1);
    expect(coverage(5, 0)).toBeNull();
    expect(failureRate(2, 38)).toBe(0.05);
    expect(failureRate(0, 0)).toBeNull();
  });
});

describe('utilization, attendance and overtime (derived)', () => {
  it('divides by scheduled time and never invents a 0 % from an empty base', () => {
    expect(utilization(6 * H, 8 * H)).toBe(0.75);
    expect(utilization(H, 0)).toBeNull();
    expect(attendanceRate(18, 20)).toBe(0.9);
    expect(overtime(9 * H, 8 * H)).toBe(H);
    expect(overtime(9 * H, 0)).toBe(0);
  });
});

describe('period summary', () => {
  // A fixture week: Mon–Fri scheduled 8 h, one absence, one late day, Saturday worked unscheduled.
  const day = (over) => ({ status: 'PRESENT', scheduledS: 8 * H, workedS: 8 * H, breakS: 1800, lateByS: 0, overtimeS: 0, trackedS: 7 * H, billableS: 5 * H, idleS: 0, monitoredS: 8 * H, screenshotsExpected: 48, screenshotsOk: 46, screenshotsFailed: 2, tasksCompleted: 1, ...over });
  const rows = [
    day({}),
    day({ lateByS: 900 }),
    day({ status: 'ABSENT', workedS: 0, breakS: 0, trackedS: 0, billableS: 0, monitoredS: 0, screenshotsExpected: 0, screenshotsOk: 0, screenshotsFailed: 0, tasksCompleted: 0 }),
    day({ workedS: 9 * H, overtimeS: H }),
    day({}),
    day({ scheduledS: 0, workedS: 2 * H, trackedS: 2 * H, billableS: 0, screenshotsExpected: 12, screenshotsOk: 12, screenshotsFailed: 0 }),
  ];

  it('produces the documented KPIs', () => {
    const s = summarize(rows);
    expect(s).toMatchObject({ scheduledDays: 5, presentDays: 5, absentDays: 1, lateDays: 1, workedS: 35 * H, overtimeS: H, trackedS: 30 * H, billableS: 20 * H, nonBillableS: 10 * H, tasksCompleted: 5 });
    expect(s.attendanceRate).toBe(4 / 5); // the unscheduled Saturday does not inflate the rate
    expect(s.utilization).toBe((20 * H) / (40 * H));
    expect(s.billableShare).toBeCloseTo(2 / 3, 6);
    expect(s.coverage).toBe(196 / 204);
    expect(s.failureRate).toBe(8 / 204);
  });

  it('returns no ratios for an empty period', () => {
    expect(summarize([])).toMatchObject({ attendanceRate: null, utilization: null, coverage: null, failureRate: null, billableShare: null });
  });
});
