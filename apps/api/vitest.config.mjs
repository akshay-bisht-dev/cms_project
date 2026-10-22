import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.js', 'src/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.js'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.js'],
          setupFiles: ['tests/helpers/integration-env.js'],
          // One shared test database: run files serially until per-worker schemas land (Phase 3).
          fileParallelism: false,
          testTimeout: 20000,
          hookTimeout: 60000,
        },
      },
      {
        // Requires the full docker-compose stack (Redis, S3). Run explicitly: vitest run --project infra
        test: {
          name: 'infra',
          include: ['tests/infra/**/*.test.js'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.js'],
          setupFiles: ['tests/helpers/integration-env.js'],
          fileParallelism: false,
          testTimeout: 20000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
