import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';

const { app, prisma } = buildTestApp();
let victim;
let attacker;
let client;

beforeAll(async () => {
  await resetDatabase(prisma);
  victim = await createOrg(prisma, { name: 'Victim' });
  attacker = await createOrg(prisma, { name: 'Attacker' });
  const vm = await createMember(prisma, victim, { name: 'Victim Employee' });
  const department = await prisma.department.create({ data: { organizationId: victim.org.id, name: 'Secret', code: 'SEC' } });
  const team = await prisma.team.create({ data: { organizationId: victim.org.id, name: 'Secret Team' } });
  const invitation = await prisma.invitation.create({
    data: { organizationId: victim.org.id, userId: vm.user.id, email: vm.user.email, tokenHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 1e9) },
  });
  victim.ids = { employee: vm.employeeId, department: department.id, team: team.id, role: victim.roles.EMPLOYEE.id, invitation: invitation.id };
  victim.member = vm;
  // The attacker is the Owner of their own organization: every permission at org scope.
  client = await login(app, attacker.owner.email);
});
afterAll(() => prisma.$disconnect());

describe('cross-organization access through the API', () => {
  const cases = [
    ['GET', (ids) => `/employees/${ids.employee}`],
    ['PATCH', (ids) => `/employees/${ids.employee}`, { designation: 'pwned' }],
    ['GET', (ids) => `/employees/${ids.employee}/history`],
    ['POST', (ids) => `/employees/${ids.employee}/deactivate`],
    ['DELETE', (ids) => `/employees/${ids.employee}`],
    ['PUT', (ids) => `/employees/${ids.employee}/roles`, null],
    ['GET', (ids) => `/departments/${ids.department}`],
    ['PATCH', (ids) => `/departments/${ids.department}`, { name: 'pwned' }],
    ['DELETE', (ids) => `/departments/${ids.department}`],
    ['GET', (ids) => `/teams/${ids.team}`],
    ['PATCH', (ids) => `/teams/${ids.team}`, { name: 'pwned' }],
    ['PUT', (ids) => `/teams/${ids.team}/members`, { employeeIds: [] }],
    ['GET', (ids) => `/roles/${ids.role}`],
    ['PATCH', (ids) => `/roles/${ids.role}`, { name: 'pwned' }],
    ['DELETE', (ids) => `/roles/${ids.role}`],
    ['POST', (ids) => `/invitations/${ids.invitation}/resend`],
    ['DELETE', (ids) => `/invitations/${ids.invitation}`],
  ];

  it.each(cases)('%s %s answers 404 and changes nothing', async (method, path, body) => {
    const payload = body === null ? { roleIds: [attacker.roles.EMPLOYEE.id] } : body;
    const res = await client[method.toLowerCase()](path(victim.ids), payload);
    expect([404, 400]).toContain(res.status);
    if (res.status === 400) expect(JSON.stringify(res.body)).not.toMatch(/Victim/);
  });

  it('never lists another organization’s records', async () => {
    const lists = await Promise.all(['/employees', '/departments', '/teams', '/roles', '/invitations'].map((p) => client.get(p)));
    const text = JSON.stringify(lists.map((r) => r.body));
    for (const id of Object.values(victim.ids)) expect(text).not.toContain(id);
    expect(text).not.toContain('Victim Employee');
  });

  it('cannot reference another organization’s records when creating its own', async () => {
    const res = await client.post('/employees', { email: 'x@example.test', name: 'X', departmentId: victim.ids.department }, { 'Idempotency-Key': 'iso-test-0001' });
    expect(res.status).toBe(400);
    const team = await client.post('/teams', { name: 'Mine', leadEmployeeId: victim.ids.employee });
    expect(team.status).toBe(400);
  });

  it('left the victim’s data untouched', async () => {
    const dept = await prisma.department.findFirst({ where: { organizationId: victim.org.id, id: victim.ids.department } });
    expect(dept).toMatchObject({ name: 'Secret', archivedAt: null });
    const member = await prisma.organizationMember.findFirst({ where: { organizationId: victim.org.id, id: victim.ids.employee } });
    expect(member.status).toBe('ACTIVE');
  });
});

describe('cross-organization references at the database level', () => {
  it('rejects a team membership that mixes organizations (composite foreign key)', async () => {
    const attackerTeam = await prisma.team.create({ data: { organizationId: attacker.org.id, name: 'Attacker Team' } });
    await expect(
      prisma.$executeRaw`INSERT INTO team_members (organization_id, team_id, user_id, created_at)
        VALUES (${attacker.org.id}, ${attackerTeam.id}, ${victim.member.user.id}, NOW(3))`,
    ).rejects.toThrow(/foreign key constraint/i);
  });

  it('rejects a profile pointing at another organization’s department', async () => {
    await expect(
      prisma.$executeRaw`UPDATE employee_profiles SET department_id = ${victim.ids.department}
        WHERE organization_id = ${attacker.org.id} AND user_id = ${attacker.owner.id}`,
    ).rejects.toThrow(/foreign key constraint/i);
  });
});
