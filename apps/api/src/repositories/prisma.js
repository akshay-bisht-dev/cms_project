import { PrismaClient } from '@prisma/client';
import { tenantGuardExtension } from './tenant-guard.js';

export function createPrisma({ logger, url, tenantGuard = process.env.NODE_ENV !== 'production' } = {}) {
  const prisma = new PrismaClient({
    datasourceUrl: url,
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  prisma.$on('warn', (e) => logger?.warn({ prisma: e.message }, 'prisma warning'));
  prisma.$on('error', (e) => logger?.error({ prisma: e.message }, 'prisma error'));
  if (!tenantGuard) {
    prisma.unscoped = prisma;
    return prisma;
  }
  const guarded = prisma.$extends(tenantGuardExtension());
  // Explicit escape hatch for the few legitimately cross-tenant queries (e.g. listing a user's
  // memberships at login). Every use should be obvious in review.
  Object.defineProperty(guarded, 'unscoped', { value: prisma, enumerable: false });
  return guarded;
}
