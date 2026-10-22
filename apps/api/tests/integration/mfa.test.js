import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, createClient } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { PASSWORD, createMember, createOrg, login } from '../helpers/factories.js';
import { base32Decode, hotp, timeStep } from '../../src/services/totp.js';

const { app, prisma, clock } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

const codeFor = (secret, at = clock.now()) => hotp(base32Decode(secret), timeStep(at));

async function enrol(client) {
  const setup = await client.post('/auth/mfa/setup');
  expect(setup.status).toBe(200);
  const { secret } = setup.body.data;
  const enabled = await client.post('/auth/mfa/enable', { code: codeFor(secret) });
  expect(enabled.status).toBe(200);
  return { secret, recoveryCodes: enabled.body.data.recoveryCodes };
}

describe('TOTP two-factor authentication', () => {
  it('enrols, then requires a code at the next sign-in before any organization data', async () => {
    const { owner } = await createOrg(prisma);
    const { secret, recoveryCodes } = await enrol(await login(app, owner.email));
    expect(recoveryCodes).toHaveLength(10);
    const setting = await prisma.mfaSetting.findUnique({ where: { userId: owner.id } });
    expect(setting.secretEnc).not.toContain(secret);

    clock.advance(31_000);
    const client = createClient(app);
    const res = await client.post('/auth/login', { email: owner.email, password: PASSWORD });
    expect(res.body.data).toEqual({ status: 'MFA_REQUIRED', organizations: [] });

    const blocked = await client.get('/employees');
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');
    const me = await client.get('/auth/me');
    expect(me.body.data).toMatchObject({ organization: null, permissions: [], session: { mfaPending: true } });

    expect((await client.post('/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await client.post('/auth/mfa/verify', { code: codeFor(secret) })).status).toBe(204);
    expect((await client.get('/employees')).status).toBe(200);
  });

  it('rejects replay of a code from an already-used time step', async () => {
    const { owner } = await createOrg(prisma);
    const { secret } = await enrol(await login(app, owner.email));
    clock.advance(31_000);
    const code = codeFor(secret);

    const first = createClient(app);
    await first.post('/auth/login', { email: owner.email, password: PASSWORD });
    expect((await first.post('/auth/mfa/verify', { code })).status).toBe(204);

    const second = createClient(app);
    await second.post('/auth/login', { email: owner.email, password: PASSWORD });
    expect((await second.post('/auth/mfa/verify', { code })).status).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const { owner } = await createOrg(prisma);
    const { recoveryCodes } = await enrol(await login(app, owner.email));

    const a = createClient(app);
    await a.post('/auth/login', { email: owner.email, password: PASSWORD });
    expect((await a.post('/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(204);

    const b = createClient(app);
    await b.post('/auth/login', { email: owner.email, password: PASSWORD });
    expect((await b.post('/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(401);
    expect((await b.post('/auth/mfa/verify', { recoveryCode: recoveryCodes[1] })).status).toBe(204);
  });

  it('signs out other sessions when MFA is turned on', async () => {
    const { owner } = await createOrg(prisma);
    const other = await login(app, owner.email);
    await enrol(await login(app, owner.email));
    expect((await other.get('/auth/me')).status).toBe(401);
  });

  it('disables only with the password and a valid code', async () => {
    const { owner } = await createOrg(prisma);
    const client = await login(app, owner.email);
    const { secret } = await enrol(client);
    clock.advance(31_000);
    expect((await client.post('/auth/mfa/disable', { password: 'wrong-password', code: codeFor(secret) })).status).toBe(400);
    expect((await client.post('/auth/mfa/disable', { password: PASSWORD, code: codeFor(secret) })).status).toBe(204);
    const res = await createClient(app).post('/auth/login', { email: owner.email, password: PASSWORD });
    expect(res.body.data.status).toBe('AUTHENTICATED');
  });

  it('forces enrolment when the organization requires MFA', async () => {
    const ctx = await createOrg(prisma);
    const { user } = await createMember(prisma, ctx);
    const owner = await login(app, ctx.owner.email);
    const updated = await owner.put('/organizations/current/settings/security', { mfaRequired: true, sessionIdleMinutes: null });
    expect(updated.status).toBe(200);

    const employee = await login(app, user.email);
    const blocked = await employee.get('/employees');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await employee.get('/auth/me')).body.data.mfaEnrollmentRequired).toBe(true);

    await enrol(employee);
    expect((await employee.get('/employees')).status).toBe(200);
  });
});
