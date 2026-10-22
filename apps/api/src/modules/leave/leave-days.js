// Pure leave arithmetic. Days are counted in halves so every total is an exact multiple of 0.5.

const DAY_MS = 86_400_000;
const ordinal = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * A request as half-day slots [start, end): each day has an AM slot (2n) and a PM slot (2n+1).
 * Starting in the PM skips the first morning; ending in the AM skips the last afternoon.
 */
export function halfDaySlots({ startDate, endDate, startHalf = 'FULL', endHalf = 'FULL' }) {
  const start = ordinal(startDate) * 2 + (startHalf === 'PM' ? 1 : 0);
  const end = ordinal(endDate) * 2 + (endHalf === 'AM' ? 1 : 2);
  // A one-day request "AM" or "PM" is that half only.
  if (startDate === endDate && startHalf !== 'FULL' && endHalf === 'FULL') return [start, start + 1];
  return [start, end];
}

export function slotsOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

/** Half-days of the request falling on each date: { date: 1 | 2 }. */
export function halvesByDate(request) {
  const [start, end] = halfDaySlots(request);
  const out = new Map();
  for (let slot = start; slot < end; slot += 1) {
    const date = isoOf(Math.floor(slot / 2));
    out.set(date, (out.get(date) ?? 0) + 1);
  }
  return out;
}

/**
 * Working days the request uses. `workWeight(date)` is 1 for a normal working day, 0.5 for a
 * half-day holiday, 0 for weekends/holidays/non-scheduled days. A day contributes
 * min(weight, halves ÷ 2), so half-day leave on a half-day holiday counts 0.5, not 0.25.
 */
export function countLeaveDays(request, workWeight) {
  let halves = 0;
  for (const [date, n] of halvesByDate(request)) halves += Math.min(workWeight(date) * 2, n);
  return halves / 2;
}

export function validateHalves(request, { allowsHalfDay }) {
  if (request.startDate > request.endDate) return 'The end date must be on or after the start date';
  if (request.startDate.slice(0, 4) !== request.endDate.slice(0, 4)) return 'Split leave that crosses a year into two requests';
  if (!allowsHalfDay && (request.startHalf !== 'FULL' || request.endHalf !== 'FULL')) return 'This leave type is taken in whole days';
  const [start, end] = halfDaySlots(request);
  if (end <= start) return 'The request covers no time';
  return null;
}

export const datesBetween = (from, to) => {
  const out = [];
  for (let n = ordinal(from); n <= ordinal(to); n += 1) out.push(isoOf(n));
  return out;
};
