// KPI formulas (docs/requirements.md §5). Pure functions over plain data so every formula is
// unit-tested against fixtures. Intervals are { start: Date, end: Date }, end exclusive.

const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Seconds of [start, end) that fall inside [wStart, wEnd). */
export function clipSeconds(start, end, wStart, wEnd) {
  return Math.max(0, Math.floor((Math.min(ms(end), ms(wEnd)) - Math.max(ms(start), ms(wStart))) / 1000));
}

/** Merges overlapping intervals into a sorted, disjoint list. */
export function mergeIntervals(intervals) {
  const sorted = intervals.map((i) => ({ start: ms(i.start), end: ms(i.end) })).filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out.map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
}

/** a minus b (both lists of intervals). */
export function subtractIntervals(a, b) {
  let result = mergeIntervals(a).map((i) => ({ start: ms(i.start), end: ms(i.end) }));
  for (const hole of mergeIntervals(b)) {
    const [hs, he] = [ms(hole.start), ms(hole.end)];
    result = result.flatMap((i) => {
      if (he <= i.start || hs >= i.end) return [i];
      return [
        ...(hs > i.start ? [{ start: i.start, end: hs }] : []),
        ...(he < i.end ? [{ start: he, end: i.end }] : []),
      ];
    });
  }
  return result.map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
}

/** Overlap of two interval lists. */
export function intersectIntervals(a, b) {
  const out = [];
  for (const x of mergeIntervals(a)) {
    for (const y of mergeIntervals(b)) {
      const start = Math.max(ms(x.start), ms(y.start));
      const end = Math.min(ms(x.end), ms(y.end));
      if (end > start) out.push({ start: new Date(start), end: new Date(end) });
    }
  }
  return mergeIntervals(out);
}

export const totalSeconds = (intervals, window) =>
  mergeIntervals(intervals).reduce((sum, i) => sum + (window ? clipSeconds(i.start, i.end, window.start, window.end) : clipSeconds(i.start, i.end, i.start, i.end)), 0);

/**
 * Worked and break time from sessions (open ones run until `now`). Worked = session time minus
 * breaks inside it. Returns the worked intervals too (used for monitored time).
 */
export function workTime(sessions, now) {
  const sessionIntervals = sessions.map((s) => ({ start: s.startedAt, end: s.endedAt ?? now }));
  const breakIntervals = sessions.flatMap((s) => s.breaks.map((b) => ({ start: b.startedAt, end: b.endedAt ?? s.endedAt ?? now })));
  const breaksInside = intersectIntervals(breakIntervals, sessionIntervals);
  const worked = subtractIntervals(sessionIntervals, breaksInside);
  return { workedS: totalSeconds(worked), breakS: totalSeconds(breaksInside), workedIntervals: worked };
}

/** Tracked time: Σ entry durations clipped to the window (running entries count until `now`). */
export function trackedTime(entries, window, now) {
  let trackedS = 0;
  let billableS = 0;
  const byProject = new Map();
  for (const e of entries) {
    const s = clipSeconds(e.startedAt, e.endedAt ?? now, window.start, window.end);
    if (!s) continue;
    trackedS += s;
    if (e.isBillable) billableS += s;
    const key = e.projectId ?? null;
    const row = byProject.get(key) ?? { projectId: key, trackedS: 0, billableS: 0 };
    row.trackedS += s;
    if (e.isBillable) row.billableS += s;
    byProject.set(key, row);
  }
  return { trackedS, billableS, byProject: [...byProject.values()] };
}

/**
 * Consent windows from the member's acknowledgement history: each ACKNOWLEDGED record opens a
 * window that the next record (of any kind) closes.
 */
export function consentWindows(records, now) {
  const sorted = [...records].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  return sorted
    .map((r, i) => (r.action === 'ACKNOWLEDGED' ? { start: r.createdAt, end: sorted[i + 1]?.createdAt ?? now } : null))
    .filter(Boolean);
}

/** Expected captures = ⌊monitored active time ÷ interval⌋ (0 when monitoring was off). */
export function expectedCaptures(monitoredS, intervalS) {
  return intervalS > 0 ? Math.floor(monitoredS / intervalS) : 0;
}

/** n ÷ d, or null when there is nothing to divide by (shown as "—", never as 0 %). */
export const ratio = (n, d) => (d > 0 ? n / d : null);

/** Screenshot coverage = ok ÷ expected, capped at 100 % (random capture offsets can exceed it). */
export const coverage = (ok, expected) => (expected > 0 ? Math.min(1, ok / expected) : null);

/** Upload failure rate = failed ÷ (ok + failed). */
export const failureRate = (failed, ok) => ratio(failed, ok + failed);

/** Billable utilization = billable time ÷ scheduled working time. */
export const utilization = (billableS, scheduledS) => ratio(billableS, scheduledS);

/** Attendance rate = days present ÷ scheduled working days. */
export const attendanceRate = (presentDays, scheduledDays) => ratio(presentDays, scheduledDays);

/** Overtime for a day = max(0, worked − scheduled); none when nothing was scheduled. */
export const overtime = (workedS, scheduledS) => (scheduledS > 0 ? Math.max(0, workedS - scheduledS) : 0);

const SUMMED = ['scheduledS', 'workedS', 'breakS', 'overtimeS', 'trackedS', 'billableS', 'idleS', 'monitoredS', 'screenshotsExpected', 'screenshotsOk', 'screenshotsFailed', 'tasksCompleted'];

/** Running totals for daily stat rows (presentScheduled is internal: the attendance rate's numerator). */
export function emptyTotals() {
  return { days: 0, scheduledDays: 0, presentDays: 0, absentDays: 0, lateDays: 0, presentScheduled: 0, ...Object.fromEntries(SUMMED.map((k) => [k, 0])) };
}

export function addRow(t, r) {
  t.days += 1;
  if (r.scheduledS > 0) t.scheduledDays += 1;
  if (r.status === 'PRESENT') t.presentDays += 1;
  if (r.status === 'ABSENT') t.absentDays += 1;
  if (r.lateByS > 0) t.lateDays += 1;
  // Present on a day without a schedule still counts as present, but not toward the rate's base.
  if (r.scheduledS > 0 && r.status === 'PRESENT') t.presentScheduled += 1;
  for (const k of SUMMED) t[k] += r[k] ?? 0;
  return t;
}

export function mergeTotals(a, b) {
  const out = emptyTotals();
  for (const k of Object.keys(out)) out[k] = (a?.[k] ?? 0) + (b?.[k] ?? 0);
  return out;
}

/** Totals plus the derived ratios, as reports and dashboards show them. */
export function finishTotals(t) {
  const { presentScheduled, ...totals } = t;
  return {
    ...totals,
    nonBillableS: t.trackedS - t.billableS,
    attendanceRate: attendanceRate(presentScheduled, t.scheduledDays),
    utilization: utilization(t.billableS, t.scheduledS),
    billableShare: ratio(t.billableS, t.trackedS),
    coverage: coverage(t.screenshotsOk, t.screenshotsExpected),
    failureRate: failureRate(t.screenshotsFailed, t.screenshotsOk),
  };
}

/** Sums daily stat rows into period totals plus the derived ratios. */
export function summarize(rows) {
  const t = emptyTotals();
  for (const r of rows) addRow(t, r);
  return finishTotals(t);
}
