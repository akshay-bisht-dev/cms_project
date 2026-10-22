import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 3100;
const WEB_URL = `http://localhost:${WEB_PORT}`;
export const E2E_PASSWORD = 'E2e-Passphrase-2026';

const apiEnv = {
  // The API may run as a least-privilege user (SELECT/INSERT/UPDATE/DELETE only), as in production;
  // global setup still migrates and seeds with DATABASE_URL_E2E.
  DATABASE_URL: process.env.DATABASE_URL_E2E_APP ?? process.env.DATABASE_URL_E2E ?? 'mysql://orbit_app:orbit_app_dev@localhost:3306/orbit_e2e_test',
  PORT: String(API_PORT),
  APP_ORIGIN: WEB_URL,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  LOG_PRETTY: 'false',
  // Tests sign in many times as the same users; rate limits have their own API tests.
  RATE_LIMIT_ENABLED: 'false',
};

const webEnv = {
  API_INTERNAL_URL: `http://localhost:${API_PORT}`,
  NEXT_PUBLIC_REALTIME_URL: `http://localhost:${API_PORT}`,
  NEXT_DIST_DIR: '.next-e2e',
  NEXT_TELEMETRY_DISABLED: '1',
  PORT: String(WEB_PORT),
};

/**
 * End-to-end tests against the real API (port 4100, database orbit_e2e_test) and a production
 * build of the web app (port 3100). The database is reset and seeded in globalSetup.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.js',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --env-file-if-exists=../../.env ../api/src/server.js',
      url: `http://localhost:${API_PORT}/api/v1/health/live`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'next build && next start --port 3100',
      url: `${WEB_URL}/login`,
      env: webEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
