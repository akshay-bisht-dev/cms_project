import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E_PASSWORD } from '../playwright.config.mjs';

/** Resets and seeds orbit_e2e_test so every run starts from the same data. */
export default function globalSetup() {
  const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
  execFileSync(process.execPath, ['--env-file-if-exists=../../.env', 'scripts/prepare-e2e-db.js'], {
    cwd: apiDir,
    env: { ...process.env, SEED_PASSWORD: E2E_PASSWORD },
    stdio: 'inherit',
  });
}
