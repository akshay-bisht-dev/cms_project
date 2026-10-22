import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { challengeMessage } from '../../src/modules/monitoring/agent-auth.js';
import { processScreenshot, purgeExpiredScreenshots, sweepStaleUploads } from '../../src/modules/monitoring/jobs.js';
import { tmpKeyFor } from '../../src/modules/monitoring/monitoring.service.js';

const { app, prisma, clock, storage } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T04:00:00Z');
  storage.objects.clear();
  await resetDatabase(prisma);
});

const MIN = 60_000;
const DAY = 86400_000;
const jobDeps = { prisma, storage, clock };
let n = 0;
const key = () => ({ 'Idempotency-Key': `monitoring-test-${Date.now()}-${++n}` });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const NOTICE = 'Screenshots of your active screen are taken every few minutes while you are clocked in and working.';
const SETTINGS = {
  captureEnabled: true,
  intervalS: 600,
  minIntervalS: 300,
  maxIntervalS: 1800,
  blur: false,
  captureMode: 'ACTIVE_SCREEN',
  excludedApps: ['1Password'],
  idleDetectionEnabled: false,
  retentionDays: 30,
  noticeText: NOTICE,
};

async function setup() {
  const ctx = await createOrg(prisma);
  const owner = await login(app, ctx.owner.email);
  const emp = await createMember(prisma, ctx, { name: 'Esha Employee' });
  const peer = await createMember(prisma, ctx, { name: 'Pat Peer' });
  return { ctx, owner, emp, employee: await login(app, emp.user.email), peer, peerClient: await login(app, peer.user.email) };
}

async function orgPolicy(owner) {
  const res = await owner.get('/monitoring/policies');
  expect(res.status).toBe(200);
  return res.body.data.find((p) => p.scopeLevel === 'ORG');
}

async function enableMonitoring(owner, settings = {}) {
  const policy = await orgPolicy(owner);
  const published = await owner.post(`/monitoring/policies/${policy.id}/versions`, { ...SETTINGS, ...settings });
  expect(published.status).toBe(201);
  expect((await owner.patch(`/monitoring/policies/${policy.id}`, { isActive: true })).status).toBe(200);
  return published.body.data;
}

async function acknowledge(client) {
  const me = (await client.get('/monitoring/me')).body.data;
  const res = await client.post('/monitoring/me/consent', { action: 'ACKNOWLEDGED', policyVersionId: me.version.id });
  expect(res.status).toBe(200);
  return res.body.data;
}

/** A desktop agent: an Ed25519 key pair plus a bearer-token HTTP client. */
async function pairAgent(client, { deviceName = 'Work laptop' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const { code } = (await client.post('/monitoring/me/pairing-codes')).body.data;
  const res = await request(app).post('/api/v1/monitoring/agent/register').send({ pairingCode: code, publicKey: rawPublic, deviceName, os: 'darwin', agentVersion: '0.1.0' });
  expect(res.status).toBe(201);
  const agent = { id: res.body.data.agentId, token: res.body.data.accessToken, privateKey, code };
  agent.call = (method, path, body) => {
    const req = request(app)[method](`/api/v1/monitoring/agent${path}`).set('Authorization', `Bearer ${agent.token}`);
    return body === undefined ? req : req.send(body);
  };
  agent.signedToken = async () => {
    const { nonce } = (await request(app).post('/api/v1/monitoring/agent/challenge').send({ agentId: agent.id })).body.data;
    const ts = Math.floor(clock.now().getTime() / 1000);
    const signature = sign(null, challengeMessage({ agentId: agent.id, nonce, ts }), privateKey).toString('base64');
    return { agentId: agent.id, nonce, ts, signature };
  };
  /** Tokens last 15 minutes; the real agent refreshes the same way. */
  agent.refresh = async () => {
    const res = await request(app).post('/api/v1/monitoring/agent/token').send(await agent.signedToken());
    agent.token = res.body.data.accessToken;
  };
  return agent;
}

async function png(width = 1280, height = 800) {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();
}

/** Presign → "PUT" into fake storage → complete. Returns the screenshot id. */
async function upload(agent, policyVersionId, { capturedAt = clock.now(), body } = {}) {
  const bytes = body ?? (await png());
  const presign = await agent.call('post', '/uploads/presign', {
    clientCaptureId: randomUUID(),
    capturedAt: capturedAt.toISOString(),
    policyVersionId,
    sha256: sha(bytes),
    sizeBytes: bytes.length,
    mimeType: 'image/png',
    width: 1280,
    height: 800,
  });
  if (presign.status !== 200) return { presign };
  const shot = await prisma.unscoped.screenshot.findUnique({ where: { id: presign.body.data.screenshotId } });
  storage.objects.set(tmpKeyFor(shot), { body: bytes, contentLength: bytes.length, contentType: 'image/png' });
  const complete = await agent.call('post', '/uploads/complete', { screenshotId: shot.id });
  return { presign, complete, id: shot.id, bytes };
}

async function workingEmployee() {
  const s = await setup();
  const version = await enableMonitoring(s.owner);
  await acknowledge(s.employee);
  expect((await s.employee.post('/attendance/clock-in', {}, key())).status).toBe(201);
  const agent = await pairAgent(s.employee);
  return { ...s, version: version.currentVersion, agent };
}

describe('policy, notice and consent', () => {
  it('is off by default and the employee page says so', async () => {
    const { employee } = await setup();
    const me = (await employee.get('/monitoring/me')).body.data;
    expect(me).toMatchObject({ enabled: false, reason: 'MONITORING_OFF', consent: { status: 'REQUIRED' } });
    expect(me.version.noticeText).toMatch(/clocked in/);
    expect(me.viewers.map((v) => v.role)).toContain('Organization Owner');
  });

  it('gates capture on consent, work state and breaks, and requires re-acknowledgement after a material change', async () => {
    const { owner, employee } = await setup();
    const policy = await enableMonitoring(owner);
    const agent = await pairAgent(employee);
    const permit = async () => (await agent.call('post', '/heartbeat', { state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' })).body.data;

    expect(await permit()).toMatchObject({ capture: false, reason: 'CONSENT_REQUIRED' });
    await acknowledge(employee);
    expect(await permit()).toMatchObject({ capture: false, reason: 'CLOCKED_OUT' });
    await employee.post('/attendance/clock-in', {}, key());
    expect(await permit()).toMatchObject({ capture: true, reason: null, intervalS: 600, excludedApps: ['1Password'], policyVersionId: policy.currentVersion.id });
    await employee.post('/attendance/break/start');
    expect(await permit()).toMatchObject({ capture: false, reason: 'ON_BREAK' });
    await employee.post('/attendance/break/end');

    // A shorter interval is a material change: capture stops until the new notice is acknowledged.
    await owner.post(`/monitoring/policies/${policy.id}/versions`, { ...SETTINGS, intervalS: 300 });
    expect(await permit()).toMatchObject({ capture: false, reason: 'CONSENT_REQUIRED' });
    const stale = await employee.post('/monitoring/me/consent', { action: 'ACKNOWLEDGED', policyVersionId: policy.currentVersion.id });
    expect(stale.status).toBe(409);
    await acknowledge(employee);
    expect(await permit()).toMatchObject({ capture: true, intervalS: 300 });

    const me = (await employee.get('/monitoring/me')).body.data;
    await employee.post('/monitoring/me/consent', { action: 'WITHDRAWN', policyVersionId: me.version.id });
    expect(await permit()).toMatchObject({ capture: false, reason: 'CONSENT_WITHDRAWN' });

    // The org master switch turns everything off.
    await acknowledge(employee);
    await owner.patch(`/monitoring/policies/${policy.id}`, { isActive: false });
    expect(await permit()).toMatchObject({ capture: false, reason: 'MONITORING_OFF' });
  });

  it('keeps consent history and published versions immutable', async () => {
    const { owner, employee, ctx } = await setup();
    await enableMonitoring(owner);
    await acknowledge(employee);
    await expect(prisma.$executeRaw`UPDATE monitoring_consent_records SET action = 'WITHDRAWN'`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM monitoring_consent_records`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE monitoring_policy_versions SET interval_s = 1 WHERE organization_id = ${ctx.org.id}`).rejects.toThrow(/immutable/);
  });

  it('resolves precedence: member over team (priority, then least invasive) over org, clamped to org bounds', async () => {
    const { owner, ctx, emp } = await setup();
    await enableMonitoring(owner);
    const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'Support' } });
    const team2 = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'Night shift' } });
    await prisma.teamMember.createMany({ data: [team, team2].map((t) => ({ organizationId: ctx.org.id, teamId: t.id, userId: emp.user.id })) });
    const effective = async () => (await owner.get(`/monitoring/policies/effective?employeeId=${emp.employeeId}`)).body.data;

    const strict = (await owner.post('/monitoring/policies', { name: 'Support', scopeLevel: 'TEAM', settings: { intervalS: 120, retentionDays: 10 } })).body.data;
    const relaxed = (await owner.post('/monitoring/policies', { name: 'Night', scopeLevel: 'TEAM', settings: { intervalS: 1500 } })).body.data;
    await owner.put(`/monitoring/policies/${strict.id}/assignments`, { targets: [{ type: 'TEAM', id: team.id, priority: 1 }] });
    await owner.put(`/monitoring/policies/${relaxed.id}/assignments`, { targets: [{ type: 'TEAM', id: team2.id, priority: 1 }] });
    // Equal priority: the less invasive (longer interval) wins.
    expect(await effective()).toMatchObject({ source: 'TEAM', policy: { id: relaxed.id }, settings: { intervalS: 1500 } });

    await owner.put(`/monitoring/policies/${strict.id}/assignments`, { targets: [{ type: 'TEAM', id: team.id, priority: 5 }] });
    // Higher priority wins; 120 s is clamped up to the org minimum of 300 s; retention can only shrink.
    expect(await effective()).toMatchObject({ source: 'TEAM', policy: { id: strict.id }, settings: { intervalS: 300, retentionDays: 10 } });

    const personal = (await owner.post('/monitoring/policies', { name: 'Esha off', scopeLevel: 'MEMBER', settings: { captureEnabled: false } })).body.data;
    await owner.put(`/monitoring/policies/${personal.id}/assignments`, { targets: [{ type: 'MEMBER', id: emp.employeeId, priority: 0 }] });
    expect(await effective()).toMatchObject({ source: 'MEMBER', enabled: false, reason: 'POLICY_DISABLED' });

    const tooLong = await owner.post('/monitoring/policies', { name: 'Keep forever', scopeLevel: 'TEAM', settings: { retentionDays: 365 } });
    expect(tooLong.status).toBe(400);
    const wrongTarget = await owner.put(`/monitoring/policies/${strict.id}/assignments`, { targets: [{ type: 'MEMBER', id: emp.employeeId }] });
    expect(wrongTarget.status).toBe(400);
  });

  it('lets only policy managers change policies and only org-wide readers list them', async () => {
    const { owner, employee } = await setup();
    const policy = await orgPolicy(owner);
    expect((await employee.get('/monitoring/policies')).status).toBe(403);
    expect((await employee.post(`/monitoring/policies/${policy.id}/versions`, SETTINGS)).status).toBe(403);
    expect((await employee.patch(`/monitoring/policies/${policy.id}`, { isActive: true })).status).toBe(403);
    expect((await employee.get('/monitoring/policies/effective')).status).toBe(200);
  });
});

describe('desktop agent authentication', () => {
  it('pairs with a one-time code and notifies the employee', async () => {
    const { employee, emp, ctx } = await setup();
    const agent = await pairAgent(employee);
    const reuse = await request(app).post('/api/v1/monitoring/agent/register').send({ pairingCode: agent.code, publicKey: Buffer.alloc(32, 1).toString('base64'), deviceName: 'Other', os: 'win32' });
    expect(reuse.status).toBe(401);
    const note = await prisma.notification.findFirst({ where: { organizationId: ctx.org.id, recipientUserId: emp.user.id, type: 'monitoring.agent_paired' } });
    expect(note.title).toMatch(/Work laptop/);
    const agents = (await employee.get('/monitoring/agents')).body.data;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ deviceName: 'Work laptop', status: 'ACTIVE' });
  });

  it('rejects expired pairing codes and malformed keys', async () => {
    const { employee } = await setup();
    const { code } = (await employee.post('/monitoring/me/pairing-codes')).body.data;
    const badKey = await request(app).post('/api/v1/monitoring/agent/register').send({ pairingCode: code, publicKey: 'not-a-key', deviceName: 'X', os: 'linux' });
    expect(badKey.status).toBe(400);
    clock.advance(6 * MIN);
    const expired = await request(app).post('/api/v1/monitoring/agent/register').send({ pairingCode: code, publicKey: Buffer.alloc(32, 7).toString('base64'), deviceName: 'X', os: 'linux' });
    expect(expired.status).toBe(401);
  });

  it('issues tokens only for a fresh, correctly signed, single-use challenge', async () => {
    const { employee } = await setup();
    const agent = await pairAgent(employee);
    const signed = await agent.signedToken();
    const ok = await request(app).post('/api/v1/monitoring/agent/token').send(signed);
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
    // Replay of the same signed challenge.
    expect((await request(app).post('/api/v1/monitoring/agent/token').send(signed)).status).toBe(401);
    // Signed by a different key.
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = await agent.signedToken();
    forged.signature = sign(null, challengeMessage(forged), other).toString('base64');
    expect((await request(app).post('/api/v1/monitoring/agent/token').send(forged)).status).toBe(401);
    // Expired challenge.
    const late = await agent.signedToken();
    clock.advance(2 * MIN);
    late.ts = Math.floor(clock.now().getTime() / 1000);
    late.signature = sign(null, challengeMessage(late), agent.privateKey).toString('base64');
    expect((await request(app).post('/api/v1/monitoring/agent/token').send(late)).status).toBe(401);
  });

  it('expires access tokens and never lets them act as a browser session', async () => {
    const { employee } = await setup();
    const agent = await pairAgent(employee);
    const asUser = await request(app).get('/api/v1/monitoring/me').set('Authorization', `Bearer ${agent.token}`);
    expect(asUser.status).toBe(401);
    const tampered = await request(app).post('/api/v1/monitoring/agent/heartbeat').set('Authorization', `Bearer ${agent.token}x`).send({ state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' });
    expect(tampered.body.error.code).toBe('INVALID_TOKEN');
    clock.advance(16 * MIN);
    const expired = await agent.call('post', '/heartbeat', { state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('INVALID_TOKEN');
  });

  it('revokes agents (by the employee, by offboarding) and refuses them immediately', async () => {
    const { employee, owner, emp } = await setup();
    const agent = await pairAgent(employee);
    const second = await pairAgent(employee, { deviceName: 'Desktop' });
    const revoke = await employee.post(`/monitoring/agents/${agent.id}/revoke`);
    expect(revoke.body.data.status).toBe('REVOKED');
    const hb = await agent.call('post', '/heartbeat', { state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' });
    expect(hb.status).toBe(401);
    expect(hb.body.error.code).toBe('AGENT_REVOKED');
    expect((await request(app).post('/api/v1/monitoring/agent/challenge').send({ agentId: agent.id })).body.error.code).toBe('AGENT_REVOKED');

    expect((await owner.post(`/employees/${emp.employeeId}/deactivate`)).status).toBe(200);
    const after = await second.call('post', '/heartbeat', { state: 'PAUSED', queueDepth: 0, queueBytes: 0, osPermission: 'granted' });
    expect(after.body.error.code).toBe('AGENT_REVOKED');
    expect(await prisma.unscoped.desktopAgent.count({ where: { userId: emp.user.id, status: 'ACTIVE' } })).toBe(0);
  });

  it('does not let a peer revoke someone else’s device', async () => {
    const { employee, peerClient, owner } = await setup();
    const agent = await pairAgent(employee);
    expect((await peerClient.post(`/monitoring/agents/${agent.id}/revoke`)).status).toBe(404);
    expect((await owner.post(`/monitoring/agents/${agent.id}/revoke`)).status).toBe(200);
  });
});

describe('uploads', () => {
  it('uploads idempotently and processes the image into WebP variants', async () => {
    const { agent, version, ctx } = await workingEmployee();
    clock.advance(5 * MIN);
    const first = await upload(agent, version.id);
    expect(first.presign.body.data).toMatchObject({ status: 'PENDING_UPLOAD', upload: { method: 'PUT' } });
    expect(first.complete.body.data).toMatchObject({ status: 'UPLOADED' });
    expect(await prisma.outboxEvent.count({ where: { organizationId: ctx.org.id, type: 'screenshot.process' } })).toBe(1);

    // Retried complete and retried presign are no-ops.
    expect((await agent.call('post', '/uploads/complete', { screenshotId: first.id })).body.data.status).toBe('UPLOADED');
    const shot = await prisma.unscoped.screenshot.findUnique({ where: { id: first.id } });
    const retry = await agent.call('post', '/uploads/presign', {
      clientCaptureId: shot.clientCaptureId, capturedAt: shot.capturedAt.toISOString(), policyVersionId: version.id, sha256: shot.sha256, sizeBytes: shot.sizeBytes, mimeType: 'image/png', width: 1280, height: 800,
    });
    expect(retry.body.data).toMatchObject({ screenshotId: first.id, status: 'UPLOADED', upload: null });
    const mismatch = await agent.call('post', '/uploads/presign', {
      clientCaptureId: shot.clientCaptureId, capturedAt: shot.capturedAt.toISOString(), policyVersionId: version.id, sha256: 'a'.repeat(64), sizeBytes: shot.sizeBytes, mimeType: 'image/png', width: 1280, height: 800,
    });
    expect(mismatch.status).toBe(409);
    expect(await prisma.unscoped.screenshot.count()).toBe(1);

    expect(await processScreenshot(jobDeps, { organizationId: ctx.org.id, screenshotId: first.id })).toEqual({ status: 'READY' });
    const ready = await prisma.unscoped.screenshot.findUnique({ where: { id: first.id } });
    expect(ready).toMatchObject({ status: 'READY', mimeType: 'image/webp', width: 1280, height: 800 });
    expect(ready.retentionExpiresAt.getTime() - ready.capturedAt.getTime()).toBe(30 * DAY);
    const stored = await sharp(storage.objects.get(ready.storageKey).body).metadata();
    expect(stored).toMatchObject({ format: 'webp', width: 1280 });
    expect((await sharp(storage.objects.get(ready.thumbKey).body).metadata()).width).toBe(320);
    expect(storage.objects.has(tmpKeyFor(shot))).toBe(false);
    // Processing twice is harmless.
    expect(await processScreenshot(jobDeps, { organizationId: ctx.org.id, screenshotId: first.id })).toEqual({ skipped: true });
  });

  it('rejects uploads whose bytes do not match or are not images', async () => {
    const { agent, version, ctx } = await workingEmployee();
    clock.advance(MIN);
    const garbage = Buffer.from('<?php echo "not an image"; ?>'.repeat(20));
    const bad = await upload(agent, version.id, { body: garbage });
    expect(await processScreenshot(jobDeps, { organizationId: ctx.org.id, screenshotId: bad.id })).toEqual({ status: 'REJECTED', failureCode: 'INVALID_IMAGE' });

    clock.advance(MIN);
    const swapped = await upload(agent, version.id);
    const row = await prisma.unscoped.screenshot.findUnique({ where: { id: swapped.id } });
    const other = await png(64, 64);
    storage.objects.set(tmpKeyFor(row), { body: other, contentLength: other.length, contentType: 'image/png' });
    expect(await processScreenshot(jobDeps, { organizationId: ctx.org.id, screenshotId: swapped.id })).toEqual({ status: 'REJECTED', failureCode: 'CHECKSUM_MISMATCH' });

    // Declared size differs from what arrived in storage.
    clock.advance(MIN);
    const bytes = await png();
    const pre = await agent.call('post', '/uploads/presign', { clientCaptureId: randomUUID(), capturedAt: clock.now().toISOString(), policyVersionId: version.id, sha256: sha(bytes), sizeBytes: bytes.length, mimeType: 'image/png', width: 1280, height: 800 });
    const r = await prisma.unscoped.screenshot.findUnique({ where: { id: pre.body.data.screenshotId } });
    expect((await agent.call('post', '/uploads/complete', { screenshotId: r.id })).status).toBe(422); // not uploaded yet
    storage.objects.set(tmpKeyFor(r), { body: bytes, contentLength: bytes.length + 5, contentType: 'image/png' });
    expect((await agent.call('post', '/uploads/complete', { screenshotId: r.id })).status).toBe(422);
    expect((await prisma.unscoped.screenshot.findUnique({ where: { id: r.id } })).status).toBe('REJECTED');
  });

  it('refuses captures from before the policy, during a break, or without consent', async () => {
    const { agent, version, employee } = await workingEmployee();
    const before = await upload(agent, version.id, { capturedAt: new Date(clock.now().getTime() - 10 * MIN) });
    expect(before.presign.status).toBe(422);
    expect(before.presign.body.error).toMatchObject({ code: 'CAPTURE_NOT_PERMITTED', details: [{ message: 'POLICY_DISABLED' }] });

    clock.advance(10 * MIN);
    await employee.post('/attendance/break/start');
    clock.advance(5 * MIN);
    await agent.refresh();
    const onBreak = await upload(agent, version.id);
    expect(onBreak.presign.body.error.details[0].message).toBe('ON_BREAK');
    await employee.post('/attendance/break/end');

    const me = (await employee.get('/monitoring/me')).body.data;
    await employee.post('/monitoring/me/consent', { action: 'WITHDRAWN', policyVersionId: me.version.id });
    clock.advance(MIN);
    const withdrawn = await upload(agent, version.id);
    expect(withdrawn.presign.status).toBe(422);
    expect(withdrawn.presign.body.error.code).toBe('CONSENT_REQUIRED');

    const future = await upload(agent, version.id, { capturedAt: new Date(clock.now().getTime() + 10 * MIN) });
    expect(future.presign.status).toBe(400);
  });

  it('accepts captures queued offline after clock-out, but only from within the session', async () => {
    const { agent, version, employee } = await workingEmployee();
    clock.advance(20 * MIN);
    const capturedAt = clock.now();
    clock.advance(10 * MIN);
    await employee.post('/attendance/clock-out', undefined, key());
    clock.advance(2 * 3600_000);
    // The agent re-authenticates (its token expired) and drains its queue.
    await agent.refresh();
    const late = await upload(agent, version.id, { capturedAt });
    expect(late.complete.body.data.status).toBe('UPLOADED');
    const afterClockOut = await upload(agent, version.id, { capturedAt: new Date(capturedAt.getTime() + 20 * MIN) });
    expect(afterClockOut.presign.body.error).toMatchObject({ code: 'CAPTURE_NOT_PERMITTED', details: [{ message: 'OUTSIDE_WORK_SESSION' }] });
  });

  it('records failed captures so gaps are explained, and sweeps uploads that never finished', async () => {
    const { agent, version, ctx, emp } = await workingEmployee();
    clock.advance(MIN);
    const fail = await agent.call('post', '/uploads/fail', { clientCaptureId: randomUUID(), capturedAt: clock.now().toISOString(), policyVersionId: version.id, code: 'DROPPED_QUEUE_FULL' });
    expect(fail.body.data.status).toBe('FAILED');
    const bytes = await png();
    await agent.call('post', '/uploads/presign', { clientCaptureId: randomUUID(), capturedAt: clock.now().toISOString(), policyVersionId: version.id, sha256: sha(bytes), sizeBytes: bytes.length, mimeType: 'image/png', width: 1280, height: 800 });
    clock.advance(25 * 3600_000);
    expect(await sweepStaleUploads(jobDeps)).toEqual({ failed: 1 });
    const statuses = (await prisma.unscoped.screenshot.findMany({ select: { status: true, failureCode: true } })).map((s) => `${s.status}:${s.failureCode}`).sort();
    expect(statuses).toEqual(['FAILED:DROPPED_QUEUE_FULL', 'FAILED:UPLOAD_TIMEOUT']);
    // Sessions idle out over a day; sign in again.
    const ownerAgain = await login(app, ctx.owner.email);
    const timeline = (await ownerAgain.get(`/monitoring/timeline?employeeId=${emp.employeeId}&date=2026-10-21`)).body.data;
    expect(timeline.screenshots.map((s) => s.failureCode).sort()).toEqual(['DROPPED_QUEUE_FULL', 'UPLOAD_TIMEOUT']);
    expect(timeline.sessions).toHaveLength(1);
  });
});

describe('viewing, access control and retention', () => {
  async function readyShot() {
    const s = await workingEmployee();
    clock.advance(5 * MIN);
    const { id } = await upload(s.agent, s.version.id);
    await processScreenshot(jobDeps, { organizationId: s.ctx.org.id, screenshotId: id });
    return { ...s, id };
  }
  const range = () => `from=${new Date(clock.now().getTime() - DAY).toISOString()}&to=${new Date(clock.now().getTime() + MIN).toISOString()}`;

  it('shows captures to the employee and org viewers, logs every view, and hides them from peers and other orgs', async () => {
    const { id, owner, employee, peerClient, emp } = await readyShot();
    const mine = await employee.get(`/monitoring/screenshots?${range()}`);
    expect(mine.body.data.map((s) => s.id)).toEqual([id]);
    expect((await owner.get(`/monitoring/screenshots?employeeId=${emp.employeeId}&${range()}`)).body.data).toHaveLength(1);

    expect((await peerClient.get(`/monitoring/screenshots?${range()}`)).body.data).toHaveLength(0);
    expect((await peerClient.get(`/monitoring/screenshots?employeeId=${emp.employeeId}&${range()}`)).status).toBe(403);
    expect((await peerClient.get(`/monitoring/screenshots/${id}`)).status).toBe(404);
    expect((await peerClient.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'full' })).status).toBe(404);

    const other = await createOrg(prisma);
    const outsider = await login(app, other.owner.email);
    expect((await outsider.get(`/monitoring/screenshots/${id}`)).status).toBe(404);
    expect((await outsider.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'thumb' })).status).toBe(404);
    expect((await outsider.delete(`/monitoring/screenshots/${id}`)).status).toBe(404);

    const urls = (await owner.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'thumb' })).body.data;
    expect(urls[0].url).toMatch(/thumbs\//);
    expect(new Date(urls[0].expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    await employee.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'download' });
    const log = (await employee.get(`/monitoring/screenshots/${id}/access-log`)).body.data;
    expect(log.map((l) => l.action).sort()).toEqual(['DOWNLOAD', 'VIEW_THUMB']);
    expect((await owner.get(`/monitoring/screenshots/${id}/access-log`)).status).toBe(200);
  });

  it('requires the download permission separately from viewing', async () => {
    const { id, ctx, emp } = await readyShot();
    const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD' });
    const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'Platform', leadUserId: lead.user.id } });
    await prisma.teamMember.create({ data: { organizationId: ctx.org.id, teamId: team.id, userId: emp.user.id } });
    const leadClient = await login(app, lead.user.email);
    expect((await leadClient.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'full' })).status).toBe(200);
    expect((await leadClient.post('/monitoring/screenshots/access-urls', { ids: [id], variant: 'download' })).status).toBe(403);
    expect((await leadClient.get(`/monitoring/screenshots/${id}/access-log`)).status).toBe(403);
  });

  it('deletes on expiry, respects legal holds, and keeps a deletion log', async () => {
    const { id, owner, emp, ctx } = await readyShot();
    const hold = await owner.post('/monitoring/legal-holds', { name: 'Case 42', reason: 'Litigation', targets: [{ type: 'MEMBER', id: emp.employeeId }] });
    expect(hold.status).toBe(201);
    expect((await prisma.unscoped.screenshot.findUnique({ where: { id } })).legalHold).toBe(true);
    const blocked = await owner.delete(`/monitoring/screenshots/${id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LEGAL_HOLD');

    clock.advance(31 * DAY);
    expect(await purgeExpiredScreenshots(jobDeps)).toEqual({ deleted: 0 });
    const stored = await prisma.unscoped.screenshot.findUnique({ where: { id } });
    expect(storage.objects.has(stored.storageKey)).toBe(true);

    const owner2 = await login(app, ctx.owner.email);
    expect((await owner2.post(`/monitoring/legal-holds/${hold.body.data.id}/release`)).status).toBe(200);
    expect(await purgeExpiredScreenshots(jobDeps)).toEqual({ deleted: 1 });
    const gone = await prisma.unscoped.screenshot.findUnique({ where: { id } });
    expect(gone).toMatchObject({ status: 'DELETED', storageKey: null, thumbKey: null });
    expect(storage.objects.has(stored.storageKey)).toBe(false);
    expect(storage.objects.has(stored.thumbKey)).toBe(false);
    const log = (await owner2.get(`/monitoring/deletions?from=${new Date(clock.now().getTime() - DAY).toISOString()}&to=${new Date(clock.now().getTime() + MIN).toISOString()}`)).body.data;
    expect(log).toMatchObject([{ screenshotId: id, reason: 'RETENTION', actor: null }]);
  });

  it('applies new holds to captures that arrive later, and lets owners delete unheld captures', async () => {
    const { owner, emp, agent, version, ctx, employee } = await workingEmployee();
    await owner.post('/monitoring/legal-holds', { name: 'Audit', reason: 'Investigation', targets: [{ type: 'MEMBER', id: emp.employeeId, fromDate: '2026-10-21', toDate: '2026-10-21' }] });
    clock.advance(MIN);
    const { id } = await upload(agent, version.id);
    expect((await prisma.unscoped.screenshot.findUnique({ where: { id } })).legalHold).toBe(true);

    const holds = (await owner.get('/monitoring/legal-holds')).body.data;
    await owner.post(`/monitoring/legal-holds/${holds.holds[0].id}/release`);
    await processScreenshot(jobDeps, { organizationId: ctx.org.id, screenshotId: id });
    expect((await employee.delete(`/monitoring/screenshots/${id}`)).status).toBe(403);
    expect((await owner.delete(`/monitoring/screenshots/${id}`)).status).toBe(204);
    expect((await owner.get(`/monitoring/screenshots/${id}`)).status).toBe(404);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: ctx.org.id, action: 'monitoring.screenshot_deleted' } });
    expect(audit.targetId).toBe(id);
  });
});
