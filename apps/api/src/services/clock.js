/** Injectable time source. Services call clock.now() so tests can control time precisely. */
export const systemClock = Object.freeze({ now: () => new Date() });

/** A controllable clock for tests: `clock.set(iso)`, `clock.advance(ms)`. */
export function createFixedClock(start = '2026-01-01T00:00:00.000Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
