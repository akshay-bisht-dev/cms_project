import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT_ENV = fileURLToPath(new URL('../../../../.env', import.meta.url));

/**
 * Builds the environment for integration tests: root .env (if present) + process env, with
 * DATABASE_URL pointed at DATABASE_URL_TEST. Throws unless the database name ends in _test,
 * so destructive tests can never touch a development or production database.
 */
export function buildTestEnv() {
  const fromFile = existsSync(ROOT_ENV) ? parseEnv(readFileSync(ROOT_ENV, 'utf8')) : {};
  const merged = { ...fromFile, ...process.env };
  const url = merged.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set (see .env.example)');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against database "${dbName}": name must end with _test`);
  }
  return {
    ...merged,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    DATABASE_URL: url,
    APP_ORIGIN: 'http://localhost:3000',
    // Individual tests opt back in; otherwise repeated logins would trip the auth limits.
    RATE_LIMIT_ENABLED: 'false',
  };
}
