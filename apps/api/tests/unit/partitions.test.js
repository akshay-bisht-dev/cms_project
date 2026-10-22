import { describe, expect, it } from 'vitest';
import { parseBound, planPartitions, retentionMonthsFor } from '../../src/jobs/partitions.js';

const p = (name, day) => ({ name, bound: day ? new Date(`${day}T00:00:00Z`) : null });
const layout = [p('p_before', '2026-07-01'), p('p202607', '2026-08-01'), p('p202608', '2026-09-01'), p('p202609', '2026-10-01'), p('p202610', '2026-11-01'), p('pmax')];

describe('partition planning', () => {
  it('parses information_schema bounds', () => {
    expect(parseBound("'2026-08-01 00:00:00'")).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(parseBound('MAXVALUE')).toBeNull();
    expect(() => parseBound('42')).toThrow();
  });

  it('adds the current month and the months ahead that are missing, above the highest bound', () => {
    const plan = planPartitions(layout, { now: new Date('2026-10-22T10:00:00Z'), aheadMonths: 3, retentionMonths: 24 });
    expect(plan.add).toEqual([
      { name: 'p202611', lessThan: '2026-12-01' },
      { name: 'p202612', lessThan: '2027-01-01' },
      { name: 'p202701', lessThan: '2027-02-01' },
    ]);
    expect(plan.drop).toEqual([]);
  });

  it('drops only partitions whose every row is older than the cutoff', () => {
    // 3 months before October → cutoff 1 July: p_before (< 1 July) goes, p202607 (< 1 August) stays.
    const plan = planPartitions(layout, { now: new Date('2026-10-01T00:00:00Z'), aheadMonths: 0, retentionMonths: 3 });
    expect(plan.cutoff).toBe('2026-07-01');
    expect(plan.drop).toEqual(['p_before']);
  });

  it('never drops pmax or the last bounded partition, even after a long gap', () => {
    const plan = planPartitions(layout, { now: new Date('2030-01-15T00:00:00Z'), aheadMonths: 1, retentionMonths: 3 });
    expect(plan.drop).toEqual(['p_before', 'p202607', 'p202608', 'p202609']);
    expect(plan.add.map((a) => a.name)).toEqual(['p203001', 'p203002']);
  });

  it('reports unpartitioned tables and refuses a layout without pmax', () => {
    expect(planPartitions([], { now: new Date(), retentionMonths: 3 }).partitioned).toBe(false);
    expect(() => planPartitions([p('p202607', '2026-08-01')], { now: new Date(), retentionMonths: 3 })).toThrow(/pmax/);
  });

  it('validates retention settings; archived tables keep at least 12 months', () => {
    expect(retentionMonthsFor('audit_logs', {})).toBe(24);
    expect(retentionMonthsFor('activity_events', { RETENTION_ACTIVITY_MONTHS: '6' })).toBe(6);
    expect(() => retentionMonthsFor('audit_logs', { RETENTION_AUDIT_MONTHS: '6' })).toThrow(/12 months/);
    expect(() => retentionMonthsFor('login_attempts', { RETENTION_LOGIN_ATTEMPT_MONTHS: 'x' })).toThrow();
  });
});
