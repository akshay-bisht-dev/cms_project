// Prepares the end-to-end test database: applies migrations, empties every table, and seeds the
// demo organizations. Refuses any database whose name does not end in "_e2e_test".
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrisma } from '../src/repositories/prisma.js';

const url = process.env.DATABASE_URL_E2E;
if (!url) throw new Error('DATABASE_URL_E2E is not set');
const name = new URL(url).pathname.slice(1);
if (!name.endsWith('_e2e_test')) throw new Error(`Refusing to prepare "${name}": name must end with _e2e_test`);

const apiDir = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' };
execFileSync(fileURLToPath(new URL('../node_modules/.bin/prisma', import.meta.url)), ['migrate', 'deploy'], { cwd: apiDir, env, stdio: 'pipe' });

const prisma = createPrisma({ url });
try {
  const tables = await prisma.$queryRaw`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT IN ('_prisma_migrations', 'permissions')`;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name: table } of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  });
} finally {
  await prisma.$disconnect();
}

execFileSync(process.execPath, ['prisma/seed.js'], { cwd: apiDir, env, stdio: 'inherit' });
