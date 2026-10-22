import { describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/repositories/prisma.js';
import { TENANT_MODELS } from '../../src/repositories/tenant-guard.js';

// The guard rejects before any SQL is sent, so no database connection is needed here.
const prisma = createPrisma({ url: 'mysql://nobody:nothing@127.0.0.1:1/none', tenantGuard: true });

describe('tenant guard', () => {
  it('covers the organization-owned models', () => {
    for (const model of ['OrganizationMember', 'EmployeeProfile', 'Department', 'Team', 'Role', 'Invitation']) {
      expect(TENANT_MODELS.has(model), model).toBe(true);
    }
    expect(TENANT_MODELS.has('User')).toBe(false);
  });

  it.each([
    ['findMany without a filter', () => prisma.department.findMany()],
    ['findFirst by id only', () => prisma.team.findFirst({ where: { id: 'x' } })],
    ['findUnique by id only', () => prisma.role.findUnique({ where: { id: 'x' } })],
    ['updateMany by id only', () => prisma.department.updateMany({ where: { id: 'x' }, data: { name: 'n' } })],
    ['deleteMany without a filter', () => prisma.teamMember.deleteMany()],
    ['create without organizationId', () => prisma.department.create({ data: { name: 'n', code: 'N' } })],
    ['count by user only', () => prisma.organizationMember.count({ where: { userId: 'u' } })],
  ])('blocks %s', async (_name, run) => {
    await expect(run()).rejects.toThrow(/Tenant guard/);
  });
});
