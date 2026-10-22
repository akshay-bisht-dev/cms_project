/** Queue names and defaults shared by producers (api, outbox relay) and consumers (worker). */
export const QUEUES = Object.freeze({
  MAINTENANCE: 'maintenance',
  EMAIL: 'email',
  ATTENDANCE: 'attendance',
  MONITORING: 'monitoring',
  REPORTS: 'reports',
  SUPPORT: 'support',
  INTEGRATIONS: 'integrations',
});

/** Which queue each outbox event type is delivered to. */
export const OUTBOX_ROUTES = Object.freeze({
  'email.send': QUEUES.EMAIL,
  'screenshot.process': QUEUES.MONITORING,
  'report.generate': QUEUES.REPORTS,
  'stats.backfill': QUEUES.REPORTS,
  'stats.refresh': QUEUES.REPORTS,
  'webhook.event': QUEUES.INTEGRATIONS,
});

export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // Failed jobs are kept for inspection; this is the dead-letter set.
  removeOnFail: { age: 14 * 24 * 3600 },
});
