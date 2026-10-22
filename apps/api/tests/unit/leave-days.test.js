import { describe, expect, it } from 'vitest';
import { countLeaveDays, halfDaySlots, slotsOverlap, validateHalves } from '../../src/modules/leave/leave-days.js';

// Mon 2026-10-19 … Sun 2026-10-25; Friday 23rd is a half-day holiday, Monday 26th a holiday.
const weight = (d) => ({ '2026-10-24': 0, '2026-10-25': 0, '2026-10-23': 0.5, '2026-10-26': 0 })[d] ?? 1;
const req = (startDate, endDate, startHalf = 'FULL', endHalf = 'FULL') => ({ startDate, endDate, startHalf, endHalf });

describe('leave days', () => {
  it('counts working days, skipping weekends and holidays', () => {
    expect(countLeaveDays(req('2026-10-19', '2026-10-22'), weight)).toBe(4);
    expect(countLeaveDays(req('2026-10-22', '2026-10-27'), weight)).toBe(1 + 0.5 + 0 + 0 + 0 + 1); // Thu, half Fri, weekend, holiday Mon, Tue
    expect(countLeaveDays(req('2026-10-24', '2026-10-25'), weight)).toBe(0);
  });

  it('counts half days at either end', () => {
    expect(countLeaveDays(req('2026-10-19', '2026-10-19', 'AM'), weight)).toBe(0.5);
    expect(countLeaveDays(req('2026-10-19', '2026-10-19', 'PM'), weight)).toBe(0.5);
    expect(countLeaveDays(req('2026-10-19', '2026-10-21', 'PM', 'AM'), weight)).toBe(2); // ½ + 1 + ½
    expect(countLeaveDays(req('2026-10-23', '2026-10-23', 'AM'), weight)).toBe(0.5); // half-day leave on a half-day holiday
  });

  it('detects overlap at half-day precision', () => {
    const morning = halfDaySlots(req('2026-10-19', '2026-10-19', 'AM'));
    const afternoon = halfDaySlots(req('2026-10-19', '2026-10-19', 'PM'));
    const week = halfDaySlots(req('2026-10-19', '2026-10-23'));
    expect(slotsOverlap(morning, afternoon)).toBe(false);
    expect(slotsOverlap(morning, week)).toBe(true);
    expect(slotsOverlap(halfDaySlots(req('2026-10-21', '2026-10-22', 'PM')), halfDaySlots(req('2026-10-19', '2026-10-21', 'FULL', 'AM')))).toBe(false);
  });

  it('validates shape', () => {
    expect(validateHalves(req('2026-10-20', '2026-10-19'), { allowsHalfDay: true })).toMatch(/after/);
    expect(validateHalves(req('2026-12-31', '2027-01-02'), { allowsHalfDay: true })).toMatch(/year/);
    expect(validateHalves(req('2026-10-19', '2026-10-19', 'AM'), { allowsHalfDay: false })).toMatch(/whole days/);
    expect(validateHalves(req('2026-10-19', '2026-10-19'), { allowsHalfDay: false })).toBeNull();
  });
});
