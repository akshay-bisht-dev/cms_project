import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '');
}

const secret = (name) => z.string().min(32, `${name} must be at least 32 characters`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_ORIGIN: z.url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: bool.default(false),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    BODY_LIMIT: z.string().default('100kb'),
    // Internal Prometheus endpoint (GET /metrics); 0 disables it. Never route it through Nginx.
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),

    DATABASE_URL: z.string().startsWith('mysql://'),
    DATABASE_REPLICA_URL: z.string().startsWith('mysql://').optional(),

    REDIS_URL: z.string().startsWith('redis').default('redis://localhost:6379'),
    REDIS_KEY_PREFIX: z.string().default('orbit:'),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool.default(false),
    S3_BUCKET_CAPTURES: z.string().min(3),
    S3_BUCKET_FILES: z.string().min(3),

    SESSION_SECRET: secret('SESSION_SECRET'),
    CSRF_SECRET: secret('CSRF_SECRET'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(60 * 24 * 7).default(720),
    SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    // Comma-separated "kid:base64key" pairs (32-byte keys). The first key encrypts; all keys decrypt.
    FIELD_ENCRYPTION_KEYS: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,16}:[A-Za-z0-9+/=_-]{43,44}(,[A-Za-z0-9_-]{1,16}:[A-Za-z0-9+/=_-]{43,44})*$/, 'must be kid:base64key[,kid:base64key]'),
    RATE_LIMIT_ENABLED: bool.default(true),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('Orbit <no-reply@orbit.local>'),

    SENTRY_DSN: z.url().optional(),
    SWAGGER_ENABLED: bool.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.LOG_PRETTY) ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'must be false in production' });
      if (!env.APP_ORIGIN.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'must use https in production' });
      }
    }
    // Guard against destructive tests ever pointing at a real database.
    if (env.NODE_ENV === 'test' && !databaseName(env.DATABASE_URL).endsWith('_test')) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'test database name must end with _test' });
    }
  });

/** Every variable the API and worker read (docs/environment.md documents each; a test keeps them in step). */
export const ENV_KEYS = Object.freeze(Object.keys(envSchema.shape));

/**
 * Validates configuration from an env-like object. Exits loudly instead of booting
 * half-configured: a missing secret should never surface as a runtime 500.
 */
export function loadEnv(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    const error = new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
    error.code = 'INVALID_ENV';
    throw error;
  }
  const env = result.data;
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
    cookieSecure: env.APP_ORIGIN.startsWith('https://'),
  });
}
