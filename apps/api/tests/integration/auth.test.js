import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, createClient } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { PASSWORD, createMember, createOrg, lastEmail, login } from '../helpers/factories.js';
import { createFieldCipher } from '../../src/services/crypto.js';

const { app, prisma, clock, env } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

const MINUTE = 60_000;

describe('organization registration and email verification', () => {
  const registration = {
    organizationName: 'Northwind Tech',
    timeZone: 'Asia/Kolkata',
    baseCurrency: 'INR',
    ownerName: 'Nora Owner',
    email: 'Nora@Northwind.test',
    password: PASSWORD,
  };

  it('registers an organization, requires verification, then signs in as owner', async () => {
    const client = createClient(app);
    const res = await client.post('/organizations', registration);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ slug: 'northwind-tech', emailVerificationRequired: true });

    const blocked = await client.post('/auth/login', { email: 'nora@northwind.test', password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const email = await lastEmail(prisma, cipher, 'nora@northwind.test');
    expect(email.template).toBe('verify-email');
    expect(email.link).toMatch(/^http:\/\/localhost:3000\/verify-email\?token=/);
    expect((await client.post('/auth/verify-email', { token: email.token })).status).toBe(204);
    // Tokens are single use.
    expect((await client.post('/auth/verify-email', { token: email.token })).body.error.code).toBe('INVALID_TOKEN');

    const signedIn = await login(app, 'nora@northwind.test');
    expect(signedIn.loginResponse.body.data.status).toBe('AUTHENTICATED');
    const me = await signedIn.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.organization).toMatchObject({ name: 'Northwind Tech', timeZone: 'Asia/Kolkata', baseCurrency: 'INR' });
    expect(me.body.data.permissions.find((p) => p.key === 'roles.manage')).toEqual({ key: 'roles.manage', scopes: ['org'] });
  });

  it('rejects a second registration with the same email', async () => {
    await createClient(app).post('/organizations', registration);
    const again = await createClient(app).post('/organizations', { ...registration, organizationName: 'Other' });
    expect(again.status).toBe(409);
  });

  it('never stores the raw verification token', async () => {
    await createClient(app).post('/organizations', registration);
    const { token } = await lastEmail(prisma, cipher, 'nora@northwind.test');
    const rows = await prisma.authToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
    const outbox = JSON.stringify(await prisma.outboxEvent.findMany());
    expect(outbox).not.toContain(token);
  });
});

describe('login', () => {
  it('sets HttpOnly session and readable CSRF cookies', async () => {
    const { owner } = await createOrg(prisma);
    const res = await createClient(app).post('/auth/login', { email: owner.email, password: PASSWORD });
    const cookies = res.headers['set-cookie'].join('\n');
    expect(cookies).toMatch(/orbit_sid=[^;]+;.*HttpOnly/);
    expect(cookies).toMatch(/SameSite=Lax/);
    expect(cookies).not.toMatch(/orbit_csrf=[^;]+;[^\n]*HttpOnly/);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash/);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { owner } = await createOrg(prisma);
    const wrong = await createClient(app).post('/auth/login', { email: owner.email, password: 'nope-nope-nope' });
    const unknown = await createClient(app).post('/auth/login', { email: 'ghost@example.test', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(await prisma.loginAttempt.count({ where: { success: false } })).toBe(2);
  });

  it('locks the account after five failures and unlocks after the lockout window', async () => {
    const { owner } = await createOrg(prisma);
    for (let i = 0; i < 5; i += 1) await createClient(app).post('/auth/login', { email: owner.email, password: 'wrong-password' });

    const locked = await createClient(app).post('/auth/login', { email: owner.email, password: PASSWORD });
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    clock.advance(16 * MINUTE);
    const ok = await createClient(app).post('/auth/login', { email: owner.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: owner.id } })).failedLoginCount).toBe(0);
  });

  it('asks users with several organizations to choose one, and only lets them pick their own', async () => {
    const first = await createOrg(prisma, { name: 'First' });
    const second = await createOrg(prisma, { name: 'Second' });
    const stranger = await createOrg(prisma, { name: 'Stranger' });
    await createMember(prisma, second, { email: first.owner.email, role: 'EMPLOYEE' });

    const client = createClient(app);
    const res = await client.post('/auth/login', { email: first.owner.email, password: PASSWORD });
    expect(res.body.data.status).toBe('ORGANIZATION_SELECTION_REQUIRED');
    expect(res.body.data.organizations.map((o) => o.name).sort()).toEqual(['First', 'Second']);

    const before = await client.get('/employees');
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('ORGANIZATION_REQUIRED');

    expect((await client.post('/auth/select-organization', { organizationId: stranger.org.id })).status).toBe(404);
    expect((await client.post('/auth/select-organization', { organizationId: second.org.id })).status).toBe(200);
    const me = await client.get('/auth/me');
    expect(me.body.data.organization.name).toBe('Second');
    expect(me.body.data.permissions.some((p) => p.key === 'roles.manage')).toBe(false);
  });

  it('refuses login for deactivated members with no other organization', async () => {
    const ctx = await createOrg(prisma);
    const { user } = await createMember(prisma, ctx, { status: 'DEACTIVATED' });
    const res = await createClient(app).post('/auth/login', { email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('sessions', () => {
  it('logs out and rejects the old cookie', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    expect((await client.post('/auth/logout')).status).toBe(204);
    const me = await client.get('/auth/me');
    expect(me.status).toBe(401);
  });

  it('expires idle sessions with SESSION_EXPIRED', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    clock.advance((env.SESSION_IDLE_MINUTES + 1) * MINUTE);
    const res = await client.get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('keeps active sessions alive by sliding the idle window', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    for (let i = 0; i < 3; i += 1) {
      clock.advance((env.SESSION_IDLE_MINUTES - 10) * MINUTE);
      expect((await client.get('/auth/me')).status).toBe(200);
    }
  });

  it('lists sessions and revokes another device', async () => {
    const { owner } = await createOrg(prisma);
    const laptop = await login(app, owner.email);
    const phone = await login(app, owner.email);
    const list = await laptop.get('/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    const phoneSession = list.body.data.find((s) => !s.current);

    expect((await laptop.delete(`/auth/sessions/${phoneSession.id}`)).status).toBe(204);
    expect((await phone.get('/auth/me')).status).toBe(401);
    expect((await laptop.get('/auth/me')).status).toBe(200);
  });

  it('cannot revoke somebody else’s session', async () => {
    const a = await createOrg(prisma);
    const b = await createOrg(prisma);
    const alice = await login(app, a.owner.email);
    const bob = await login(app, b.owner.email);
    const [bobSession] = (await bob.get('/auth/sessions')).body.data;
    expect((await alice.delete(`/auth/sessions/${bobSession.id}`)).status).toBe(404);
    expect((await bob.get('/auth/me')).status).toBe(200);
  });

  it('changing the password signs out other sessions but keeps this one', async () => {
    const { owner } = await createOrg(prisma);
    const here = await login(app, owner.email);
    const elsewhere = await login(app, owner.email);
    const res = await here.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'A-Brand-New-Passphrase-2' });
    expect(res.status).toBe(204);
    expect((await here.get('/auth/me')).status).toBe(200);
    expect((await elsewhere.get('/auth/me')).status).toBe(401);
    expect((await createClient(app).post('/auth/login', { email: owner.email, password: PASSWORD })).status).toBe(401);
  });
});

describe('password reset', () => {
  it('always answers 202, resets with a single-use token, and revokes sessions', async () => {
    const { owner } = await createOrg(prisma);
    const existing = await login(app, owner.email);

    const unknown = await createClient(app).post('/auth/forgot-password', { email: 'ghost@example.test' });
    const known = await createClient(app).post('/auth/forgot-password', { email: owner.email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);

    const { token, link } = await lastEmail(prisma, cipher, owner.email);
    expect(link).toContain('/reset-password?token=');
    const reset = await createClient(app).post('/auth/reset-password', { token, password: 'Reset-Passphrase-Works-3' });
    expect(reset.status).toBe(204);
    expect((await existing.get('/auth/me')).status).toBe(401);
    expect((await createClient(app).post('/auth/reset-password', { token, password: 'Another-Passphrase-44' })).status).toBe(422);
    expect((await login(app, owner.email, { password: 'Reset-Passphrase-Works-3' })).loginResponse.status).toBe(200);
  });

  it('rejects an expired reset token', async () => {
    const { owner } = await createOrg(prisma);
    await createClient(app).post('/auth/forgot-password', { email: owner.email });
    const { token } = await lastEmail(prisma, cipher, owner.email);
    clock.advance(31 * MINUTE);
    const res = await createClient(app).post('/auth/reset-password', { token, password: 'Too-Late-Passphrase-5' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    const res = await client.agent.post('/api/v1/departments').send({ name: 'Ops', code: 'OPS' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects requests from another origin even with a valid token', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    const res = await client.agent
      .post('/api/v1/departments')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', client.csrf)
      .send({ name: 'Ops', code: 'OPS' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a CSRF token issued for a different session', async () => {
    const { owner } = await createOrg(prisma);
    const mine = await login(app, owner.email);
    const other = await login(app, owner.email);
    const res = await mine.agent.post('/api/v1/departments').set('X-CSRF-Token', other.csrf).send({ name: 'Ops', code: 'OPS' });
    expect(res.status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('limits repeated login attempts for one account from one address', async () => {
    const limited = buildTestApp({ env: { RATE_LIMIT_ENABLED: 'true' }, prisma, clock });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await createClient(limited.app).post('/auth/login', { email: 'someone@example.test', password: 'whatever-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});
