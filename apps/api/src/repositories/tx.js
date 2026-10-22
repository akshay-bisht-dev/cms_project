// MySQL deadlock (1213) and lock-wait timeout (1205) surface from Prisma as P2034 or raw codes.
const RETRYABLE = new Set(['P2034']);
const RETRYABLE_MYSQL = /\b(1213|1205)\b|Deadlock found|Lock wait timeout/;

function isRetryable(err) {
  return RETRYABLE.has(err?.code) || RETRYABLE_MYSQL.test(String(err?.message ?? ''));
}

/**
 * Runs `fn` in an interactive transaction, retrying deadlocks with jittered backoff.
 * `fn` must be safe to re-run: it receives a fresh transaction client each attempt.
 */
export async function withTransaction(prisma, fn, { maxAttempts = 3, timeout = 10000, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(fn, { timeout, maxWait: 5000 });
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      await sleep(25 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
