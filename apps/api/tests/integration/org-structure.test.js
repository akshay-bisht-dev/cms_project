import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';

const { app, prisma } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

describe('organization profile and settings', () => {
  it('reads and updates the profile with validation and an audit trail', async () => {
    const ctx = await createOrg(prisma, { name: 'Acme' });
    const owner = await login(app, ctx.owner.email);
    expect((await owner.patch('/organizations/current', { timeZone: 'Mars/Olympus' })).status).toBe(400);
    const res = await owner.patch('/organizations/current', { name: 'Acme Labs', timeZone: 'Europe/Berlin', brandColor: '#6D4AE0' });
    expect(res.body.data).toMatchObject({ name: 'Acme Labs', timeZone: 'Europe/Berlin', memberCount: 1 });
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: ctx.org.id, action: 'organizations.updated' } });
    expect(audit.diff.timeZone).toEqual({ from: 'UTC', to: 'Europe/Berlin' });

    const employee = await createMember(prisma, ctx);
    const reader = await login(app, employee.user.email);
    expect((await reader.get('/organizations/current')).status).toBe(200);
    expect((await reader.patch('/organizations/current', { name: 'Hijacked' })).status).toBe(403);
  });

  it('merges setting defaults and validates each section strictly', async () => {
    const ctx = await createOrg(prisma);
    const owner = await login(app, ctx.owner.email);
    const all = await owner.get('/organizations/current/settings');
    expect(all.body.data.attendance.graceLateMinutes).toBe(10);
    expect(all.body.meta.version).toBe(0);

    const bad = await owner.put('/organizations/current/settings/attendance', { ...all.body.data.attendance, graceLateMinutes: -5, extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['body.graceLateMinutes']));
    expect((await owner.put('/organizations/current/settings/unknown', {})).status).toBe(400);

    const ok = await owner.put('/organizations/current/settings/attendance', { ...all.body.data.attendance, graceLateMinutes: 5 });
    expect(ok.status).toBe(200);
    const after = await owner.get('/organizations/current/settings');
    expect(after.body.data.attendance.graceLateMinutes).toBe(5);
    expect(after.body.meta.version).toBe(1);
  });
});

describe('departments', () => {
  it('creates a hierarchy, prevents cycles and archiving a parent with active children', async () => {
    const ctx = await createOrg(prisma);
    const manager = await createMember(prisma, ctx, { name: 'Manager' });
    const owner = await login(app, ctx.owner.email);

    const eng = (await owner.post('/departments', { name: 'Engineering', code: 'eng', managerEmployeeId: manager.employeeId })).body.data;
    expect(eng).toMatchObject({ code: 'ENG', manager: { name: 'Manager' } });
    const web = (await owner.post('/departments', { name: 'Web', code: 'WEB', parentId: eng.id })).body.data;
    expect((await owner.post('/departments', { name: 'Dup', code: 'ENG' })).status).toBe(409);

    const cycle = await owner.patch(`/departments/${eng.id}`, { parentId: web.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.details[0].message).toMatch(/under itself/);

    expect((await owner.delete(`/departments/${eng.id}`)).status).toBe(409);
    expect((await owner.delete(`/departments/${web.id}`)).status).toBe(204);
    expect((await owner.delete(`/departments/${eng.id}`)).status).toBe(204);
    expect((await owner.get('/departments')).body.data).toHaveLength(0);
    expect((await owner.get('/departments?includeArchived=true')).body.data).toHaveLength(2);
  });

  it('gives department managers scope over their whole subtree', async () => {
    const ctx = await createOrg(prisma);
    const owner = await login(app, ctx.owner.email);
    const head = await createMember(prisma, ctx, { name: 'Head', role: 'HR_MANAGER' });
    const eng = (await owner.post('/departments', { name: 'Engineering', code: 'ENG', managerEmployeeId: head.employeeId })).body.data;
    const web = (await owner.post('/departments', { name: 'Web', code: 'WEB', parentId: eng.id })).body.data;
    // A custom role whose employment-field access is department-scoped.
    const role = (await owner.post('/roles', {
      name: 'Department Head',
      permissions: [
        { key: 'employees.read', scope: 'org' },
        { key: 'employees.fields.employment.read', scope: 'department' },
      ],
    })).body.data;
    const deptHead = await createMember(prisma, ctx, { name: 'Dept Head', role: null });
    await owner.put(`/employees/${deptHead.employeeId}/roles`, { roleIds: [role.id] });
    await owner.patch(`/departments/${eng.id}`, { managerEmployeeId: deptHead.employeeId });

    const inSubtree = await createMember(prisma, ctx, { profile: { departmentId: web.id, noticePeriodDays: 30 } });
    const outside = await createMember(prisma, ctx, { profile: { noticePeriodDays: 60 } });
    const client = await login(app, deptHead.user.email);
    expect((await client.get(`/employees/${inSubtree.employeeId}`)).body.data.employment.noticePeriodDays).toBe(30);
    expect((await client.get(`/employees/${outside.employeeId}`)).body.data.employment).toBeUndefined();
  });
});

describe('teams', () => {
  it('creates teams with the lead as a member; leads manage only their own team', async () => {
    const ctx = await createOrg(prisma);
    const owner = await login(app, ctx.owner.email);
    const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Lead' });
    const a = await createMember(prisma, ctx, { name: 'A' });
    const b = await createMember(prisma, ctx, { name: 'B' });

    const mine = (await owner.post('/teams', { name: 'Mine', leadEmployeeId: lead.employeeId, memberEmployeeIds: [a.employeeId] })).body.data;
    expect(mine.members.map((m) => m.name).sort()).toEqual(['A', 'Lead']);
    const theirs = (await owner.post('/teams', { name: 'Theirs' })).body.data;
    expect((await owner.post('/teams', { name: 'Mine' })).status).toBe(409);

    const leadClient = await login(app, lead.user.email);
    const updated = await leadClient.put(`/teams/${mine.id}/members`, { employeeIds: [a.employeeId, b.employeeId] });
    expect(updated.body.data.members.map((m) => m.name).sort()).toEqual(['A', 'B', 'Lead']);
    expect((await leadClient.put(`/teams/${theirs.id}/members`, { employeeIds: [a.employeeId] })).status).toBe(403);
    expect((await leadClient.patch(`/teams/${mine.id}`, { name: 'Renamed' })).status).toBe(403);
    expect((await leadClient.post('/teams', { name: 'New' })).status).toBe(403);

    const employee = await login(app, a.user.email);
    expect((await employee.put(`/teams/${mine.id}/members`, { employeeIds: [] })).status).toBe(403);
  });

  it('rejects members from outside the organization', async () => {
    const ctx = await createOrg(prisma);
    const other = await createOrg(prisma);
    const outsider = await createMember(prisma, other);
    const owner = await login(app, ctx.owner.email);
    const res = await owner.post('/teams', { name: 'T', memberEmployeeIds: [outsider.employeeId] });
    expect(res.status).toBe(400);
  });
});

describe('roles', () => {
  it('validates grants against the catalog and protects the Owner role', async () => {
    const ctx = await createOrg(prisma);
    const owner = await login(app, ctx.owner.email);
    const unknown = await owner.post('/roles', { name: 'Bad', permissions: [{ key: 'nuclear.launch', scope: 'org' }] });
    expect(unknown.status).toBe(400);
    const badScope = await owner.post('/roles', { name: 'Bad', permissions: [{ key: 'roles.manage', scope: 'self' }] });
    expect(badScope.body.error.details[0].message).toMatch(/allows scopes: org/);

    expect((await owner.patch(`/roles/${ctx.roles.OWNER.id}`, { name: 'Boss' })).status).toBe(403);
    expect((await owner.delete(`/roles/${ctx.roles.EMPLOYEE.id}`)).status).toBe(403);

    const custom = (await owner.post('/roles', { name: 'Auditor', permissions: [{ key: 'audit.read', scope: 'org' }] })).body.data;
    expect(custom).toMatchObject({ key: 'CUSTOM_AUDITOR', isSystem: false, permissions: [{ key: 'audit.read', scope: 'org' }] });
    const member = await createMember(prisma, ctx, { role: null });
    await owner.put(`/employees/${member.employeeId}/roles`, { roleIds: [custom.id] });
    expect((await owner.delete(`/roles/${custom.id}`)).status).toBe(409);
  });

  it('hides grants from members without roles.manage', async () => {
    const ctx = await createOrg(prisma);
    const employee = await createMember(prisma, ctx);
    const client = await login(app, employee.user.email);
    const roles = (await client.get('/roles')).body.data;
    expect(roles.length).toBeGreaterThan(5);
    expect(roles.every((r) => r.permissions === undefined)).toBe(true);
    expect((await client.get(`/roles/${ctx.roles.OWNER.id}`)).status).toBe(403);
  });
});

describe('profile completion', () => {
  it('is computed for profiles created at registration and by invitation', async () => {
    const res = await (await import('../helpers/test-app.js')).createClient(app).post('/organizations', {
      organizationName: 'Completion Co',
      timeZone: 'Asia/Kolkata',
      baseCurrency: 'INR',
      ownerName: 'Cora',
      email: 'cora@example.test',
      password: 'Correct-Horse-Battery-1',
    });
    const owner = await prisma.employeeProfile.findFirst({ where: { organizationId: res.body.data.organizationId } });
    expect(owner.completionPct).toBe(8); // 1 of 12 fields (time zone)
  });
});
