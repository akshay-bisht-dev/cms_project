import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/orbit',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET_CAPTURES: 'captures',
  S3_BUCKET_FILES: 'files',
  SESSION_SECRET: 's'.repeat(32),
  CSRF_SECRET: 'c'.repeat(32),
  FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
};

describe('loadEnv', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.swaggerEnabled).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('lists every invalid variable in one error', () => {
    const { SESSION_SECRET: _s, ...rest } = base;
    expect(() => loadEnv({ ...rest, CSRF_SECRET: 'short', PORT: 'abc' })).toThrow(
      /SESSION_SECRET[\s\S]*CSRF_SECRET[\s\S]*PORT|PORT[\s\S]*SESSION_SECRET/,
    );
  });

  it('refuses a test run against a database not named *_test', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test' })).toThrow(/must end with _test/);
    expect(loadEnv({ ...base, NODE_ENV: 'test', DATABASE_URL: 'mysql://u:p@localhost/orbit_test' }).isTest).toBe(true);
  });

  it('rejects malformed field encryption keys', () => {
    expect(() => loadEnv({ ...base, FIELD_ENCRYPTION_KEYS: 'not-a-key' })).toThrow(/FIELD_ENCRYPTION_KEYS/);
  });

  it('marks cookies secure only for https origins', () => {
    expect(loadEnv(base).cookieSecure).toBe(false);
    expect(loadEnv({ ...base, APP_ORIGIN: 'https://app.example.com' }).cookieSecure).toBe(true);
  });

  it('requires https and plain logs in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', LOG_PRETTY: 'true' })).toThrow(/APP_ORIGIN[\s\S]*https|LOG_PRETTY/);
    const env = loadEnv({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'https://app.example.com' });
    expect(env.swaggerEnabled).toBe(false);
  });
});
