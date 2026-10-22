// Creates (or updates) the least-privilege MySQL users for one Orbit database. Idempotent; re-running
// with a new password rotates it. Run by an operator or the release pipeline with an admin account:
//   DATABASE_ADMIN_URL=mysql://admin:…@host:3306/orbit \
//   DB_APP_PASSWORD=… DB_MIGRATE_PASSWORD=… DB_MAINTENANCE_PASSWORD=… DB_BACKUP_PASSWORD=… \
//   node scripts/provision-db-users.js
// A user is only created when its password variable is set. Names default to orbit_app, orbit_migrate,
// … (DB_USER_PREFIX), from any host (DB_USER_HOST). DB_REQUIRE_TLS=true adds REQUIRE SSL. Use one prefix
// per database: provisioning resets a user's privileges everywhere before granting.
//
//   app          SELECT, INSERT, UPDATE, DELETE on the schema. No DDL: it cannot ALTER, DROP or TRUNCATE,
//                so append-only tables (enforced by triggers) and their partitions stay intact.
//   migrate      DDL for `prisma migrate deploy` (release job only). Creating triggers with binary
//                logging on also needs log_bin_trust_function_creators=1 (or SUPER) on the server.
//   maintenance  SELECT, ALTER, DROP on the four partitioned event tables only (partition maintenance).
//   backup       What mysqldump --single-transaction needs to dump data, triggers and views.
//   readonly     SELECT (reporting replica, support queries).
import { PrismaClient } from '@prisma/client';

const PARTITIONED = ['activity_events', 'audit_logs', 'screenshot_access_logs', 'login_attempts'];

export function provisioningStatements({ database, prefix = 'orbit', host = '%', passwords, requireTls = false }) {
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error(`Unsafe database name: ${database}`);
  if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new Error(`Unsafe user prefix: ${prefix}`);
  if (!/^[A-Za-z0-9_.%-]+$/.test(host)) throw new Error(`Unsafe host pattern: ${host}`);
  const db = `\`${database}\``;
  const grants = {
    app: [`GRANT SELECT, INSERT, UPDATE, DELETE ON ${db}.* TO {user}`],
    migrate: [`GRANT ALL PRIVILEGES ON ${db}.* TO {user}`],
    maintenance: PARTITIONED.map((t) => `GRANT SELECT, ALTER, DROP ON ${db}.\`${t}\` TO {user}`),
    backup: [`GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON ${db}.* TO {user}`, 'GRANT PROCESS ON *.* TO {user}'],
    readonly: [`GRANT SELECT ON ${db}.* TO {user}`],
  };
  const statements = [];
  for (const [role, password] of Object.entries(passwords)) {
    if (!password) continue;
    if (!grants[role]) throw new Error(`Unknown role: ${role}`);
    // MySQL cannot bind a password as a parameter, so it is inlined, and only a generated-password
    // alphabet (base64 / base64url, e.g. `openssl rand -base64 32`) is accepted: no quotes or backslashes.
    if (!/^[A-Za-z0-9+/=_.~-]{20,128}$/.test(password)) throw new Error(`The ${role} password must be 20–128 characters of A–Z a–z 0–9 + / = _ . ~ -`);
    const user = `'${prefix}_${role}'@'${host}'`;
    const tls = requireTls ? ' REQUIRE SSL' : '';
    statements.push({ sql: `CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY '${password}'${tls}`, params: [] });
    statements.push({ sql: `ALTER USER ${user} IDENTIFIED BY '${password}'${tls}`, params: [] });
    // Start from nothing on this schema so a narrowed grant really narrows.
    statements.push({ sql: `REVOKE IF EXISTS ALL PRIVILEGES, GRANT OPTION FROM ${user} IGNORE UNKNOWN USER`, params: [] });
    for (const g of grants[role]) statements.push({ sql: g.replace('{user}', user), params: [] });
  }
  return statements;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) throw new Error('DATABASE_ADMIN_URL is not set');
  const database = process.env.DB_NAME ?? new URL(admin).pathname.slice(1);
  const statements = provisioningStatements({
    database,
    prefix: process.env.DB_USER_PREFIX ?? 'orbit',
    host: process.env.DB_USER_HOST ?? '%',
    requireTls: process.env.DB_REQUIRE_TLS === 'true',
    passwords: {
      app: process.env.DB_APP_PASSWORD,
      migrate: process.env.DB_MIGRATE_PASSWORD,
      maintenance: process.env.DB_MAINTENANCE_PASSWORD,
      backup: process.env.DB_BACKUP_PASSWORD,
      readonly: process.env.DB_READONLY_PASSWORD,
    },
  });
  if (!statements.length) throw new Error('No DB_*_PASSWORD variables set: nothing to provision');
  const prisma = new PrismaClient({ datasourceUrl: admin });
  try {
    for (const s of statements) {
      try {
        await prisma.$executeRawUnsafe(s.sql, ...s.params);
      } catch (err) {
        // Driver errors echo the statement; never let a password reach logs.
        const redact = (text) => String(text).replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '***'");
        // eslint-disable-next-line preserve-caught-error -- the driver error quotes the password; only the redacted text may leave.
        throw new Error(`${redact(s.sql)} failed: ${redact(err.meta?.message ?? err.message)}`);
      }
    }
    const users = [...new Set(statements.map((s) => /'[^']+'@'[^']+'/.exec(s.sql)[0]))];
    process.stdout.write(`Provisioned ${users.join(', ')} on ${database}\n`);
  } finally {
    await prisma.$disconnect();
  }
}
