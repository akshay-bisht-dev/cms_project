import { describe, expect, it } from 'vitest';
import { backoffMs, nextCaptureDelayMs, permitExpiresAtLocal } from '../src/scheduler.js';

describe('scheduler', () => {
  it('shifts the interval by at most ±20 %', () => {
    expect(nextCaptureDelayMs(600, () => 0)).toBe(480_000);
    expect(nextCaptureDelayMs(600, () => 0.5)).toBe(600_000);
    expect(nextCaptureDelayMs(600, () => 0.999999)).toBeLessThanOrEqual(720_000);
  });

  it('backs off exponentially up to five minutes with jitter', () => {
    expect(backoffMs(0, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBe(16_000);
    expect(backoffMs(20, () => 1)).toBe(300_000);
    expect(backoffMs(20, () => 0)).toBe(150_000);
  });

  it('applies the permit lifetime to the local clock, ignoring server clock skew', () => {
    const permit = { serverTime: '2030-01-01T00:00:00.000Z', permitExpiresAt: '2030-01-01T00:02:00.000Z' };
    expect(permitExpiresAtLocal(permit, 1_000)).toBe(121_000);
    expect(permitExpiresAtLocal(null, 1_000)).toBe(0);
  });
});
