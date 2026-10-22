import pino from 'pino';

// Never log credentials, session material, or sensitive profile data.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.emergencyContact',
  '*.personalEmail',
];

export function createLogger(env) {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: process.env.ORBIT_SERVICE ?? 'api', env: env.APP_ENV },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: env.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  });
}
