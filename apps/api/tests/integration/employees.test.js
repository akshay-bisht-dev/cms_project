import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, createClient } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, lastEmail, login } from '../helpers/factories.js';
import { createFieldCipher } from '../../src/services/crypto.js';

const { app, prisma, env } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

let key = 0;
const idem = () => ({ 'Idempotency-Key': `test-key-${Date.now()}-${++key}` });

async function setup() {
  const ctx = await createOrg(prisma, { name: 'Acme' });
  const eng = await prisma.department.create({ data: { organizationId: ctx.org.id, name: 'Engineering', code: 'ENG' } });
  const hr = await createMember(prisma, ctx, { role: 'HR_MANAGER', name: 'Hana HR' });
  const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Lee Lead', profile: { departmentId: eng.id } });
  const dev = await createMember(prisma, ctx, { role: 'EMPLOYEE', name: 'Dev One', profile: { departmentId: eng.id, phone: '+91 98765 43210' } });
  const peer = await createMember(prisma, ctx, { role: 'EMPLOYEE', name: 'Peer Two', profile: { departmentId: eng.id } });
  const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'Platform', leadUserId: lead.user.id } });
  await prisma.teamMember.createMany({
    data: [lead, dev].map((m) => ({ organizationId: ctx.org.id, teamId: team.id, userId: m.user.id })),
  });
  return { ...ctx, eng, hr, lead, dev, peer, team };
}

describe('invitations', () => {
  it('invites an employee who accepts, sets a password, and signs in', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    const created = await hr.post(
      '/employees',
      { email: 'New.Hire@Example.test', name: 'New Hire', designation: 'Engineer', departmentId: s.eng.id, teamIds: [s.team.id], employmentType: 'FULL_TIME', joiningDate: '2026-11-02' },
      idem(),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.employee).toMatchObject({ email: 'new.hire@example.test', status: 'INVITED', department: { name: 'Engineering' } });
    expect(created.body.data.employee.roles.map((r) => r.key)).toEqual(['EMPLOYEE']);

    const email = await lastEmail(prisma, cipher, 'new.hire@example.test');
    expect(email).toMatchObject({ template: 'invitation', data: { organizationName: 'Acme', inviterName: 'Hana HR' } });

    const anon = createClient(app);
    const preview = await anon.get(`/auth/invitation?token=${encodeURIComponent(email.token)}`);
    expect(preview.body.data).toMatchObject({ organizationName: 'Acme', requiresPassword: true });
    expect((await anon.post('/auth/accept-invitation', { token: email.token })).status).toBe(400);
    expect((await anon.post('/auth/accept-invitation', { token: email.token, password: 'Welcome-Aboard-2026' })).status).toBe(200);
    expect((await anon.post('/auth/accept-invitation', { token: email.token, password: 'Welcome-Aboard-2026' })).status).toBe(422);

    const newcomer = await login(app, 'new.hire@example.test', { password: 'Welcome-Aboard-2026' });
    const me = await newcomer.get('/auth/me');
    expect(me.body.data.employeeId).toBe(created.body.data.employee.employeeId);
  });

  it('lets an existing identity from another organization accept without a new password', async () => {
    const s = await setup();
    const other = await createOrg(prisma, { name: 'Other' });
    const owner = await login(app, s.owner.email);
    await owner.post('/employees', { email: other.owner.email, name: 'Contractor' }, idem());
    const { token } = await lastEmail(prisma, cipher, other.owner.email);
    const preview = await createClient(app).get(`/auth/invitation?token=${encodeURIComponent(token)}`);
    expect(preview.body.data.requiresPassword).toBe(false);
    expect((await createClient(app).post('/auth/accept-invitation', { token })).status).toBe(200);
    const memberships = await prisma.unscoped.organizationMember.findMany({ where: { userId: other.owner.id, status: 'ACTIVE' } });
    expect(memberships).toHaveLength(2);
  });

  it('resends with a fresh link that invalidates the old one, and revokes', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    await owner.post('/employees', { email: 'later@example.test', name: 'Later' }, idem());
    const first = await lastEmail(prisma, cipher, 'later@example.test');
    const [invitation] = (await owner.get('/invitations')).body.data;

    expect((await owner.post(`/invitations/${invitation.id}/resend`)).status).toBe(409); // < 1 minute
    await prisma.invitation.updateMany({ where: { organizationId: s.org.id, id: invitation.id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });
    const resent = await owner.post(`/invitations/${invitation.id}/resend`);
    expect(resent.status).toBe(200);
    const second = await lastEmail(prisma, cipher, 'later@example.test');
    expect(second.token).not.toBe(first.token);
    expect((await createClient(app).get(`/auth/invitation?token=${encodeURIComponent(first.token)}`)).status).toBe(422);

    expect((await owner.delete(`/invitations/${resent.body.data.id}`)).status).toBe(204);
    expect((await createClient(app).get(`/auth/invitation?token=${encodeURIComponent(second.token)}`)).status).toBe(422);
  });

  it('enforces the seat limit', async () => {
    const ctx = await createOrg(prisma, { seatLimit: 1 });
    const owner = await login(app, ctx.owner.email);
    const res = await owner.post('/employees', { email: 'one-too-many@example.test', name: 'Extra' }, idem());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SEAT_LIMIT_REACHED');
  });

  it('bulk-invites and reports per-row failures', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    const res = await hr.post(
      '/employees/invitations',
      { invitations: [{ email: 'a@example.test', name: 'A' }, { email: s.dev.user.email, name: 'Duplicate' }, { email: 'b@example.test', name: 'B' }] },
      idem(),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res.body.data[1].error.code).toBe('CONFLICT');
  });
});

describe('privilege escalation guard', () => {
  it('stops HR from inviting someone as Owner or with roles HR does not hold', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    const asOwner = await hr.post('/employees', { email: 'x@example.test', name: 'X', roleIds: [s.roles.OWNER.id] }, idem());
    expect(asOwner.status).toBe(403);
    const asFinance = await hr.post('/employees', { email: 'y@example.test', name: 'Y', roleIds: [s.roles.FINANCE_MANAGER.id] }, idem());
    expect(asFinance.status).toBe(403);
    const asEmployee = await hr.post('/employees', { email: 'z@example.test', name: 'Z', roleIds: [s.roles.EMPLOYEE.id] }, idem());
    expect(asEmployee.status).toBe(201);
  });

  it('keeps at least one active owner', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    const demote = await owner.put(`/employees/${s.owner.employeeId}/roles`, { roleIds: [s.roles.EMPLOYEE.id] });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');

    await owner.put(`/employees/${s.hr.employeeId}/roles`, { roleIds: [s.roles.OWNER.id] });
    expect((await owner.put(`/employees/${s.owner.employeeId}/roles`, { roleIds: [s.roles.EMPLOYEE.id] })).status).toBe(200);
  });

  it('applies deny overrides immediately', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    const hr = await login(app, s.hr.user.email);
    expect((await hr.get('/invitations')).status).toBe(200);
    await owner.put(`/employees/${s.hr.employeeId}/permission-overrides`, { deny: ['invitations.manage'], reason: 'test' });
    expect((await hr.get('/invitations')).status).toBe(403);
  });
});

describe('directory', () => {
  it('searches, filters and paginates with a stable cursor', async () => {
    const s = await setup();
    for (let i = 0; i < 7; i += 1) await createMember(prisma, s, { name: `Zed ${String(i).padStart(2, '0')}` });
    const viewer = await login(app, s.dev.user.email);

    const pages = [];
    let cursor;
    do {
      const res = await viewer.get(`/employees?q=zed&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      pages.push(res.body.data.map((e) => e.name));
      cursor = res.body.meta.page.nextCursor;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(pages.flat()).toEqual([...Array(7)].map((_, i) => `Zed ${String(i).padStart(2, '0')}`));

    const desc = await viewer.get('/employees?q=zed&sort=-name&limit=2');
    expect(desc.body.data.map((e) => e.name)).toEqual(['Zed 06', 'Zed 05']);

    const byTeam = await viewer.get(`/employees?teamId=${s.team.id}`);
    expect(byTeam.body.data.map((e) => e.name).sort()).toEqual(['Dev One', 'Lee Lead']);
    const byDept = await viewer.get(`/employees?departmentId=${s.eng.id}`);
    expect(byDept.body.data).toHaveLength(3);
    const byRole = await viewer.get(`/employees?roleId=${s.roles.HR_MANAGER.id}`);
    expect(byRole.body.data.map((e) => e.name)).toEqual(['Hana HR']);
    expect((await viewer.get('/employees?sort=password')).status).toBe(400);
  });

  it('exports CSV only for permitted roles and neutralizes formulas', async () => {
    const s = await setup();
    await createMember(prisma, s, { name: '=HYPERLINK("http://evil")' });
    const hr = await login(app, s.hr.user.email);
    const res = await hr.get('/employees/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.text.split('\r\n')[0]).toContain('phone');

    const dev = await login(app, s.dev.user.email);
    expect((await dev.get('/employees/export')).status).toBe(403);
  });
});

describe('profile field groups', () => {
  it('shows each viewer only the groups their scope covers', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    await hr.patch(`/employees/${s.dev.employeeId}`, {
      personalEmail: 'dev.home@example.test',
      address: { line1: '1 Main St', city: 'Pune', country: 'IN' },
      emergencyContact: { name: 'Mom', relationship: 'Parent', phone: '+91 90000 00000' },
      probationEndDate: '2027-01-31',
    });

    const asHr = (await hr.get(`/employees/${s.dev.employeeId}`)).body.data;
    expect(asHr.personal).toEqual({ personalEmail: 'dev.home@example.test', address: { line1: '1 Main St', city: 'Pune', country: 'IN' } });
    expect(asHr.employment.probationEndDate).toBe('2027-01-31');
    expect(asHr.access.editableGroups).toEqual(expect.arrayContaining(['basic', 'personal', 'employment']));

    const self = (await (await login(app, s.dev.user.email)).get(`/employees/${s.dev.employeeId}`)).body.data;
    expect(self.personal.personalEmail).toBe('dev.home@example.test');
    expect(self.access.editableGroups.sort()).toEqual(['contact', 'emergency', 'personal']);

    const peer = (await (await login(app, s.peer.user.email)).get(`/employees/${s.dev.employeeId}`)).body.data;
    expect(peer.name).toBe('Dev One');
    for (const group of ['work', 'contact', 'personal', 'emergency', 'employment', 'security']) expect(peer[group], group).toBeUndefined();

    const lead = (await (await login(app, s.lead.user.email)).get(`/employees/${s.dev.employeeId}`)).body.data;
    expect(lead.contact.phone).toBe('+91 98765 43210');
    expect(lead.personal).toBeUndefined();
    const leadOnPeer = (await (await login(app, s.lead.user.email)).get(`/employees/${s.peer.employeeId}`)).body.data;
    expect(leadOnPeer.contact).toBeUndefined();
  });

  it('stores sensitive fields encrypted and redacts them in history', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    expect((await dev.patch(`/employees/${s.dev.employeeId}`, { personalEmail: 'secret@example.test', phone: '+1 555 0100' })).status).toBe(200);

    const [row] = await prisma.$queryRaw`SELECT personal_email_enc AS enc FROM employee_profiles WHERE organization_id = ${s.org.id} AND user_id = ${s.dev.user.id}`;
    expect(row.enc).toMatch(/^v1\./);
    expect(row.enc).not.toContain('secret@');

    const history = (await dev.get(`/employees/${s.dev.employeeId}/history`)).body.data;
    expect(history.find((h) => h.field === 'personalEmail')).toMatchObject({ newValue: '[REDACTED]' });
    expect(history.find((h) => h.field === 'phone')).toMatchObject({ newValue: '+1 555 0100' });
    const audit = JSON.stringify(await prisma.auditLog.findMany());
    expect(audit).not.toContain('secret@example.test');
  });

  it('rejects edits outside the caller’s groups and honours the self-service setting', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    const denied = await dev.patch(`/employees/${s.dev.employeeId}`, { designation: 'CTO' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('designation');
    expect((await dev.patch(`/employees/${s.peer.employeeId}`, { phone: '+1 555 0199' })).status).toBe(403);

    const owner = await login(app, s.owner.email);
    await owner.put('/organizations/current/settings/profile', { skillsEnabled: true, selfServiceFields: ['emergency'] });
    expect((await dev.patch(`/employees/${s.dev.employeeId}`, { phone: '+1 555 0100' })).status).toBe(403);
    expect((await dev.patch(`/employees/${s.dev.employeeId}`, { emergencyContact: null })).status).toBe(200);
  });

  it('lets a team lead edit work fields of their team only', async () => {
    const s = await setup();
    const lead = await login(app, s.lead.user.email);
    expect((await lead.patch(`/employees/${s.dev.employeeId}`, { designation: 'Senior Engineer' })).status).toBe(200);
    expect((await lead.patch(`/employees/${s.peer.employeeId}`, { designation: 'Senior Engineer' })).status).toBe(403);
  });

  it('rejects reporting cycles', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    expect((await hr.patch(`/employees/${s.dev.employeeId}`, { managerEmployeeId: s.lead.employeeId })).status).toBe(200);
    const cycle = await hr.patch(`/employees/${s.lead.employeeId}`, { managerEmployeeId: s.dev.employeeId });
    expect(cycle.status).toBe(400);
    expect((await hr.patch(`/employees/${s.dev.employeeId}`, { managerEmployeeId: s.dev.employeeId })).status).toBe(400);
  });

  it('computes profile completion on the server', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    const before = (await hr.get(`/employees/${s.dev.employeeId}`)).body.data.profileCompletion;
    const after = (await hr.patch(`/employees/${s.dev.employeeId}`, { designation: 'Engineer', employeeCode: 'E-1', workLocation: 'Pune' })).body.data.profileCompletion;
    expect(after).toBeGreaterThan(before);
  });
});

describe('lifecycle', () => {
  it('deactivation signs the employee out; reactivation restores access', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    const hr = await login(app, s.hr.user.email);
    expect((await hr.post(`/employees/${s.dev.employeeId}/deactivate`)).body.data.status).toBe('DEACTIVATED');
    expect((await dev.get('/auth/me')).status).toBe(401);
    expect((await createClient(app).post('/auth/login', { email: s.dev.user.email, password: 'Correct-Horse-Battery-1' })).status).toBe(403);
    expect((await hr.post(`/employees/${s.dev.employeeId}/deactivate`)).status).toBe(409);
    expect((await hr.post(`/employees/${s.dev.employeeId}/activate`)).body.data.status).toBe('ACTIVE');
    expect((await (await login(app, s.dev.user.email)).get('/auth/me')).status).toBe(200);
  });

  it('offboards with a last working day, then archives', async () => {
    const s = await setup();
    const hr = await login(app, s.hr.user.email);
    const res = await hr.post(`/employees/${s.dev.employeeId}/offboard`, { lastWorkingDate: '2026-12-31', reason: 'Resigned' }, idem());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DEACTIVATED');
    const detail = (await hr.get(`/employees/${s.dev.employeeId}`)).body.data;
    expect(detail.employment.lastWorkingDate).toBe('2026-12-31');
    expect((await hr.delete(`/employees/${s.dev.employeeId}`)).status).toBe(204);
    expect((await hr.get('/employees')).body.data.map((e) => e.employeeId)).not.toContain(s.dev.employeeId);
    expect((await hr.get('/employees?status=ARCHIVED')).body.data.map((e) => e.employeeId)).toContain(s.dev.employeeId);
  });

  it('refuses to deactivate yourself or the last owner', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    expect((await owner.post(`/employees/${s.owner.employeeId}/deactivate`)).status).toBe(403);
    const hr = await login(app, s.hr.user.email);
    const res = await hr.post(`/employees/${s.owner.employeeId}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });
});

describe('idempotency', () => {
  it('replays the stored response for a retried request and rejects a reused key with a different body', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    const headers = idem();
    const first = await owner.post('/employees', { email: 'retry@example.test', name: 'Retry' }, headers);
    const second = await owner.post('/employees', { email: 'retry@example.test', name: 'Retry' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await prisma.invitation.count({ where: { organizationId: s.org.id, email: 'retry@example.test' } })).toBe(1);

    const mismatch = await owner.post('/employees', { email: 'other@example.test', name: 'Other' }, headers);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('requires the header on idempotent routes', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    expect((await owner.post('/employees', { email: 'n@example.test', name: 'N' })).status).toBe(400);
  });
});
