// Pure timing rules for capture and retries (docs/screenshot-monitoring.md §5–6).

/**
 * Delay until the next capture: the interval shifted by up to ±20 % at random, so captures are
 * not predictable to the second. The random offset is disclosed in the monitoring notice.
 */
export function nextCaptureDelayMs(intervalS, random = Math.random) {
  const base = intervalS * 1000;
  return Math.round(base + (random() * 0.4 - 0.2) * base);
}

/** Exponential backoff for uploads: 2 s doubling to a 5-minute cap, with jitter (50–100 %). */
export function backoffMs(attempt, random = Math.random) {
  const capped = Math.min(300_000, 2000 * 2 ** Math.max(0, attempt));
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * Local expiry of a server permit. The server states when it expires in its own clock, so the
 * remaining lifetime is applied to the local receive time (tolerates clock skew).
 */
export function permitExpiresAtLocal(permit, receivedAtMs) {
  if (!permit) return 0;
  const lifetime = Date.parse(permit.permitExpiresAt) - Date.parse(permit.serverTime);
  return receivedAtMs + Math.max(0, lifetime);
}
