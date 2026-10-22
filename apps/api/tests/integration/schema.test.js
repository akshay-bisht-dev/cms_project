import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/repositories/prisma.js';
import { resetDatabase } from '../helpers/db.js';

const prisma = createPrisma();
afterAll(() => prisma.$disconnect());

beforeEach(() => resetDatabase(prisma));

async function makeOrg(slug) {
  return prisma.organization.create({ data: { name: slug, slug } });
}

describe('schema constraints', () => {
  it('generates time-ordered UUIDv7 primary keys', async () => {
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.id < b.id).toBe(true);
  });

  it('stores timestamps in UTC with millisecond precision', async () => {
    const at = new Date('2026-03-08T06:59:59.123Z');
    const org = await makeOrg('org-tz');
    const user = await prisma.user.create({ data: { email: 'tz@example.test', name: 'TZ' } });
    const session = await prisma.userSession.create({
      data: { userId: user.id, activeOrganizationId: org.id, tokenHash: 'a'.repeat(64), expiresAt: at },
    });
    expect(session.expiresAt.toISOString()).toBe('2026-03-08T06:59:59.123Z');
    const [{ raw }] = await prisma.$queryRaw`SELECT CAST(expires_at AS CHAR) AS raw FROM user_sessions WHERE id = ${session.id}`;
    expect(raw).toBe('2026-03-08 06:59:59.123');
  });

  it('allows a user to be a member of an organization only once', async () => {
    const org = await makeOrg('org-dup');
    const user = await prisma.user.create({ data: { email: 'dup@example.test', name: 'Dup' } });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } });
    await expect(prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('lets one identity belong to several organizations', async () => {
    const [a, b] = await Promise.all([makeOrg('org-m1'), makeOrg('org-m2')]);
    const user = await prisma.user.create({ data: { email: 'multi@example.test', name: 'Multi' } });
    await prisma.organizationMember.createMany({
      data: [
        { organizationId: a.id, userId: user.id },
        { organizationId: b.id, userId: user.id },
      ],
    });
    expect(await prisma.unscoped.organizationMember.count({ where: { userId: user.id } })).toBe(2);
  });

  it('prevents deleting an organization that still has members', async () => {
    const org = await makeOrg('org-restrict');
    const user = await prisma.user.create({ data: { email: 'r@example.test', name: 'R' } });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } });
    await expect(prisma.organization.delete({ where: { id: org.id } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('treats emails case-insensitively for uniqueness', async () => {
    await prisma.user.create({ data: { email: 'case@example.test', name: 'A' } });
    await expect(prisma.user.create({ data: { email: 'CASE@example.test', name: 'B' } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('keeps audit logs append-only', async () => {
    const entry = await prisma.auditLog.create({ data: { actorType: 'SYSTEM', action: 'test.append_only' } });
    await expect(
      prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${entry.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${entry.id}`).rejects.toThrow(/append-only/);
  });
});
