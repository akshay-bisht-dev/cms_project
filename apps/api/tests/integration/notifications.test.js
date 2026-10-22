import { createServer } from 'node:http';
import { once } from 'node:events';
import pino from 'pino';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, createClient, fakeRedis, fakeStorage } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, lastEmail, login } from '../helpers/factories.js';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createFieldCipher } from '../../src/services/crypto.js';
import { createFixedClock } from '../../src/services/clock.js';
import { createRealtimeHub } from '../../src/sockets/realtime.js';
import { createSessionService } from '../../src/modules/auth/session.service.js';

const { app, prisma, env } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

describe('notifications', () => {
  it('notifies an employee when someone else edits their profile, without leaking values', async () => {
    const ctx = await createOrg(prisma);
    const hr = await createMember(prisma, ctx, { role: 'HR_MANAGER', name: 'Hana HR' });
    const dev = await createMember(prisma, ctx);
    const hrClient = await login(app, hr.user.email);
    await hrClient.patch(`/employees/${dev.employeeId}`, { personalEmail: 'private@example.test', designation: 'Engineer' });

    const devClient = await login(app, dev.user.email);
    expect((await devClient.get('/notifications/unread-count')).body.data.count).toBe(1);
    const [n] = (await devClient.get('/notifications')).body.data;
    expect(n).toMatchObject({ type: 'employees.profile_changed', title: 'Hana HR updated your profile', link: `/employees/${dev.employeeId}/profile` });
    expect(n.body).toContain('personalEmail');
    expect(n.body).not.toContain('private@example.test');

    // The default email preference for this type is on; the email carries no field values either.
    const email = await lastEmail(prisma, cipher, dev.user.email);
    expect(email.template).toBe('notification');
    expect(JSON.stringify(email)).not.toContain('private@example.test');

    // Editing your own profile does not notify you.
    await devClient.patch(`/employees/${dev.employeeId}`, { phone: '+1 555 0100' });
    expect((await devClient.get('/notifications/unread-count')).body.data.count).toBe(1);
  });

  it('marks read individually and in bulk, only for the recipient', async () => {
    const ctx = await createOrg(prisma);
    const dev = await createMember(prisma, ctx);
    const other = await createMember(prisma, ctx);
    const owner = await login(app, ctx.owner.email);
    await owner.put(`/employees/${dev.employeeId}/roles`, { roleIds: [ctx.roles.TEAM_LEAD.id] });
    await owner.patch(`/employees/${dev.employeeId}`, { designation: 'Lead' });

    const devClient = await login(app, dev.user.email);
    const list = (await devClient.get('/notifications')).body.data;
    expect(list.map((n) => n.type).sort()).toEqual(['access.roles_changed', 'employees.profile_changed']);

    const otherClient = await login(app, other.user.email);
    expect((await otherClient.post(`/notifications/${list[0].id}/read`)).status).toBe(404);

    expect((await devClient.post(`/notifications/${list[0].id}/read`)).status).toBe(204);
    expect((await devClient.get('/notifications?unreadOnly=true')).body.data).toHaveLength(1);
    expect((await devClient.post('/notifications/read-all')).body.data.updated).toBe(1);
    expect((await devClient.get('/notifications/unread-count')).body.data.count).toBe(0);
  });

  it('respects channel preferences', async () => {
    const ctx = await createOrg(prisma);
    const dev = await createMember(prisma, ctx);
    const devClient = await login(app, dev.user.email);
    const prefs = (await devClient.get('/notifications/preferences')).body.data;
    expect(prefs.find((p) => p.type === 'access.roles_changed')).toMatchObject({ inApp: true, email: true });
    await devClient.put('/notifications/preferences', { preferences: [{ type: 'access.roles_changed', inApp: false, email: false }] });
    expect((await devClient.put('/notifications/preferences', { preferences: [{ type: 'nope', inApp: true, email: true }] })).status).toBe(400);

    const owner = await login(app, ctx.owner.email);
    await owner.put(`/employees/${dev.employeeId}/roles`, { roleIds: [ctx.roles.TEAM_LEAD.id] });
    expect((await devClient.get('/notifications')).body.data).toHaveLength(0);
    expect(await lastEmail(prisma, cipher, dev.user.email)).toBeNull();
  });

  it('tells the inviter when an invitation is accepted', async () => {
    const ctx = await createOrg(prisma, { name: 'Acme' });
    const owner = await login(app, ctx.owner.email);
    await owner.post('/employees', { email: 'joiner@example.test', name: 'Jo Iner' }, { 'Idempotency-Key': 'notify-invite-1' });
    const { token } = await lastEmail(prisma, cipher, 'joiner@example.test');
    await createClient(app).post('/auth/accept-invitation', { token, password: 'Joining-Passphrase-9' });
    const [n] = (await owner.get('/notifications')).body.data;
    expect(n).toMatchObject({ type: 'employees.invitation_accepted', title: 'Jo Iner joined Acme' });
  });
});

describe('dashboard summary', () => {
  it('counts real records within the viewer scope', async () => {
    const ctx = await createOrg(prisma);
    const eng = await prisma.department.create({ data: { organizationId: ctx.org.id, name: 'Engineering', code: 'ENG' } });
    const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD' });
    const a = await createMember(prisma, ctx, { profile: { departmentId: eng.id, completionPct: 50 } });
    await createMember(prisma, ctx, { profile: { departmentId: eng.id } });
    await createMember(prisma, ctx, { status: 'INVITED' });
    const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'T', leadUserId: lead.user.id } });
    await prisma.teamMember.createMany({ data: [lead, a].map((m) => ({ organizationId: ctx.org.id, teamId: team.id, userId: m.user.id })) });

    const owner = (await (await login(app, ctx.owner.email)).get('/dashboard/summary')).body.data;
    expect(owner.scope).toBe('org');
    expect(owner.headcount).toMatchObject({ ACTIVE: 4, INVITED: 1 });
    expect(owner.byDepartment).toEqual([
      { departmentId: eng.id, name: 'Engineering', count: 2 },
      { departmentId: null, name: 'Unassigned', count: 2 },
    ]);
    expect(owner.recentJoiners).toHaveLength(4);
    expect(owner.pendingInvitations).toBe(0);

    const asLead = (await (await login(app, lead.user.email)).get('/dashboard/summary')).body.data;
    expect(asLead.scope).toBe('team');
    expect(asLead.headcount.ACTIVE).toBe(2);
    expect(asLead.pendingInvitations).toBeNull();

    const filtered = (await (await login(app, ctx.owner.email)).get(`/dashboard/summary?departmentId=${eng.id}`)).body.data;
    expect(filtered.headcount.ACTIVE).toBe(2);
  });
});

describe('real-time delivery', () => {
  async function startServer() {
    const testEnv = loadEnv(process.env);
    const clock = createFixedClock(new Date().toISOString());
    const realtime = createRealtimeHub({ env: testEnv, prisma, sessionService: createSessionService({ prisma, env: testEnv, clock }) });
    const server = createServer(createApp({ env: testEnv, logger: pino({ level: 'silent' }), prisma, clock, redis: fakeRedis(), storage: fakeStorage(), realtime }));
    realtime.attach(server);
    server.listen(0);
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    return { server, realtime, url, app: server, close: async () => (await realtime.close(), server.close()) };
  }

  // The 'ready' promise is captured at creation: the server can emit it before a later await resumes.
  const socketFor = (url, cookie, origin = 'http://localhost:3000') => {
    const socket = connect(url, { transports: ['websocket'], extraHeaders: { cookie, origin }, reconnection: false, timeout: 3000 });
    socket.ready = once(socket, 'ready');
    return socket;
  };

  const cookieHeader = (client) =>
    client.loginResponse.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');

  it('pushes notification events only to the recipient, after commit', async () => {
    const live = await startServer();
    try {
      const ctx = await createOrg(prisma);
      const dev = await createMember(prisma, ctx);
      const bystander = await createMember(prisma, ctx);
      const devSocket = socketFor(live.url, cookieHeader(await login(live.app, dev.user.email)));
      const otherSocket = socketFor(live.url, cookieHeader(await login(live.app, bystander.user.email)));
      await Promise.all([devSocket.ready, otherSocket.ready]);
      const otherEvents = [];
      otherSocket.on('notification.created', (e) => otherEvents.push(e));

      const pushed = once(devSocket, 'notification.created');
      const owner = await login(live.app, ctx.owner.email);
      await owner.put(`/employees/${dev.employeeId}/roles`, { roleIds: [ctx.roles.TEAM_LEAD.id] });
      const [event] = await pushed;
      expect(event.type).toBe('access.roles_changed');

      // A failed request (last-owner violation) rolls back and pushes nothing.
      const failed = await owner.put(`/employees/${ctx.owner.employeeId}/roles`, { roleIds: [ctx.roles.EMPLOYEE.id] });
      expect(failed.status).toBe(409);
      await new Promise((r) => setTimeout(r, 200));
      expect(otherEvents).toEqual([]);
      devSocket.close();
      otherSocket.close();
    } finally {
      await live.close();
    }
  });

  it('rejects connections without a session or from another origin, and drops revoked sessions', async () => {
    const live = await startServer();
    try {
      const anonymous = socketFor(live.url, '');
      const [anonErr] = await once(anonymous, 'connect_error');
      expect(anonErr.message).toBe('unauthenticated');

      const ctx = await createOrg(prisma);
      const client = await login(live.app, ctx.owner.email);
      const foreign = socketFor(live.url, cookieHeader(client), 'https://evil.example');
      const [originErr] = await once(foreign, 'connect_error');
      expect(originErr.message).toBe('origin not allowed');

      const socket = socketFor(live.url, cookieHeader(client));
      await socket.ready;
      const ended = once(socket, 'session.ended');
      await client.post('/auth/logout');
      await live.realtime.revalidate();
      await ended;
      await new Promise((r) => setTimeout(r, 50));
      expect(socket.connected).toBe(false);
    } finally {
      await live.close();
    }
  });
});
