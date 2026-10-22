// Tables kept across tests: the migration ledger and the code-synced permission catalog.
const KEEP = new Set(['_prisma_migrations', 'permissions']);

/**
 * Empties every table in the test database. TRUNCATE does not fire row triggers, so it also
 * clears append-only tables such as audit_logs. Guarded by the _test database-name check.
 */
export async function resetDatabase(prisma) {
  const [{ db }] = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  if (!String(db).endsWith('_test')) throw new Error(`resetDatabase refused to run against "${db}"`);
  const tables = await prisma.$queryRaw`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`;
  // The transaction only pins one connection (FOREIGN_KEY_CHECKS is per session); truncating every table
  // can take longer than Prisma's default 5 s interactive-transaction timeout.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      for (const { name } of tables) {
        if (!KEEP.has(name)) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${name}\``);
      }
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
