import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTestEnv } from './test-env.js';

const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
const PRISMA_BIN = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));

/**
 * Brings the test database up to the latest migration and syncs the permission catalog.
 * Non-destructive by design: test files reset their own data with resetDatabase().
 * After editing an already-applied migration, reset the test database yourself.
 */
export default async function setup() {
  const env = buildTestEnv();
  execFileSync(PRISMA_BIN, ['migrate', 'deploy'], { cwd: API_DIR, env, stdio: 'pipe' });
  Object.assign(process.env, env);
  const { createPrisma } = await import('../../src/repositories/prisma.js');
  const { syncPermissionCatalog } = await import('../../src/modules/rbac/index.js');
  const prisma = createPrisma();
  try {
    await syncPermissionCatalog(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
