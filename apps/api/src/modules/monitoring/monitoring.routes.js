import { idSchema, isoDateSchema, isoDateTimeSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { AGENT, PUBLIC } from '../../middleware/authorize.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { MAX_DIMENSION, MAX_UPLOAD_BYTES, UPLOAD_TYPES } from './monitoring.service.js';

const MAX_RANGE_MS = 31 * 86400_000;

const settingsSchema = z
  .object({
    captureEnabled: z.boolean(),
    intervalS: z.number().int().min(60).max(86400),
    minIntervalS: z.number().int().min(60).max(86400),
    maxIntervalS: z.number().int().min(60).max(86400),
    blur: z.boolean(),
    captureMode: z.enum(['ACTIVE_SCREEN', 'ALL_SCREENS']),
    excludedApps: z.array(z.string().trim().min(1).max(120)).max(100),
    idleDetectionEnabled: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    noticeText: z.string().trim().min(40, 'Explain what is captured in at least a sentence').max(5000),
  })
  .strict();
// Team and member policies inherit the organization's interval bounds.
const childSettingsSchema = settingsSchema.omit({ minIntervalS: true, maxIntervalS: true });

const policyParams = z.object({ policyId: idSchema }).strict();
const createPolicyBody = z.object({ name: z.string().trim().min(1).max(120), scopeLevel: z.enum(['TEAM', 'MEMBER']), settings: childSettingsSchema.partial() }).strict();
const updatePolicyBody = z.object({ name: z.string().trim().min(1).max(120), isActive: z.boolean() }).partial().strict();
const publishBody = z.union([settingsSchema, childSettingsSchema]);
const assignmentsBody = z
  .object({ targets: z.array(z.object({ type: z.enum(['TEAM', 'MEMBER']), id: idSchema, priority: z.number().int().min(0).max(1000).default(0) }).strict()).max(500) })
  .strict();
const employeeQuery = z.object({ employeeId: idSchema.optional() }).strict();
const consentBody = z.object({ action: z.enum(['ACKNOWLEDGED', 'WITHDRAWN']), policyVersionId: idSchema }).strict();
const agentParams = z.object({ agentId: idSchema }).strict();

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase hex SHA-256');
const registerBody = z
  .object({
    pairingCode: z.string().trim().min(8).max(16),
    publicKey: z.string().max(64),
    deviceName: z.string().trim().min(1).max(120),
    os: z.enum(['darwin', 'win32', 'linux']),
    osVersion: z.string().trim().max(64).optional(),
    agentVersion: z.string().trim().max(32).optional(),
  })
  .strict();
const challengeBody = z.object({ agentId: idSchema }).strict();
const tokenBody = z.object({ agentId: idSchema, nonce: z.string().min(10).max(200), ts: z.number().int(), signature: z.string().max(128) }).strict();
const heartbeatBody = z
  .object({
    state: z.enum(['CAPTURING', 'PAUSED', 'PERMISSION_MISSING', 'ERROR', 'STARTING']),
    queueDepth: z.number().int().min(0).max(100_000),
    queueBytes: z.number().int().min(0),
    osPermission: z.enum(['granted', 'denied', 'not-determined', 'restricted', 'unknown']),
    lastError: z.string().max(500).optional(),
    agentVersion: z.string().max(32).optional(),
  })
  .strict();
const presignBody = z
  .object({
    clientCaptureId: idSchema,
    capturedAt: isoDateTimeSchema,
    policyVersionId: idSchema,
    sha256: sha256Hex,
    sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    mimeType: z.enum(Object.keys(UPLOAD_TYPES)),
    width: z.number().int().min(1).max(MAX_DIMENSION),
    height: z.number().int().min(1).max(MAX_DIMENSION),
  })
  .strict();
const completeBody = z.object({ screenshotId: idSchema }).strict();
const idleBody = z.object({ intervals: z.array(z.object({ id: idSchema, startedAt: isoDateTimeSchema, endedAt: isoDateTimeSchema }).strict()).min(1).max(50) }).strict();
const failBody = z
  .object({
    clientCaptureId: idSchema,
    capturedAt: isoDateTimeSchema,
    policyVersionId: idSchema,
    code: z.enum(['DROPPED_QUEUE_FULL', 'EXPIRED', 'CAPTURE_FAILED', 'UPLOAD_FAILED', 'PERMISSION_DENIED']),
  })
  .strict();

const rangeRefine = (q) => new Date(q.from) < new Date(q.to) && new Date(q.to) - new Date(q.from) <= MAX_RANGE_MS;
const rangeIssue = { path: ['to'], message: 'to must be after from, at most 31 days apart' };
const statusList = z
  .string()
  .transform((s) => s.split(',').filter(Boolean))
  .pipe(z.array(z.enum(['PENDING_UPLOAD', 'UPLOADED', 'READY', 'FAILED', 'REJECTED'])).min(1));
const listQuery = z
  .object({
    employeeId: idSchema.optional(),
    projectId: idSchema.optional(),
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    status: statusList.optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(48),
  })
  .strict()
  .refine(rangeRefine, rangeIssue);
const timelineQuery = z.object({ employeeId: idSchema.optional(), date: isoDateSchema }).strict();
const shotParams = z.object({ screenshotId: idSchema }).strict();
const accessBody = z.object({ ids: z.array(idSchema).min(1).max(60), variant: z.enum(['thumb', 'full', 'download']) }).strict();
const deletionQuery = z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }).strict().refine(rangeRefine, rangeIssue);
const holdParams = z.object({ holdId: idSchema }).strict();
const holdBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(1000),
    targets: z
      .array(z.object({ type: z.enum(['MEMBER', 'PROJECT']), id: idSchema, fromDate: isoDateSchema.optional(), toDate: isoDateSchema.optional() }).strict())
      .min(1)
      .max(100),
  })
  .strict();

export function monitoringRoutes({ monitoringService, cursorCodec }) {
  const tags = ['Monitoring'];
  const agentTags = ['Desktop agent'];
  return defineRoutes('/monitoring', (r) => {
    // ─── the employee's own monitoring ──────────────────────────────────────
    r.get('/me', { permission: 'monitoring.self', tags, summary: 'My monitoring status: policy, notice, consent, devices, who can see captures' }, async (req, res) => {
      sendOk(res, await monitoringService.me(req.ctx));
    });
    r.post('/me/consent', { permission: 'monitoring.self', body: consentBody, tags, summary: 'Acknowledge the current monitoring notice, or withdraw' }, async (req, res) => {
      sendOk(res, await monitoringService.recordConsent(req.ctx, req.valid.body));
    });
    r.post('/me/pairing-codes', { permission: 'monitoring.self', tags, summary: 'One-time code (5 minutes) to connect the desktop app' }, async (req, res) => {
      sendCreated(res, await monitoringService.createPairingCode(req.ctx));
    });

    // ─── policies ───────────────────────────────────────────────────────────
    r.get('/policies', { permission: 'monitoring.policy.read', tags, summary: 'Capture policies and their assignments' }, async (req, res) => {
      sendOk(res, await monitoringService.listPolicies(req.ctx));
    });
    r.post('/policies', { permission: 'monitoring.policy.manage', body: createPolicyBody, tags, summary: 'Create a team or member policy' }, async (req, res) => {
      sendCreated(res, await monitoringService.createPolicy(req.ctx, req.valid.body));
    });
    r.get('/policies/effective', { permission: 'monitoring.policy.read', query: employeeQuery, tags, summary: 'The policy in force for an employee (default: me)' }, async (req, res) => {
      sendOk(res, await monitoringService.effectiveFor(req.ctx, req.valid.query.employeeId));
    });
    r.patch('/policies/:policyId', { permission: 'monitoring.policy.manage', params: policyParams, body: updatePolicyBody, tags, summary: 'Rename or (de)activate a policy; the ORG policy is the master switch' }, async (req, res) => {
      sendOk(res, await monitoringService.updatePolicy(req.ctx, req.valid.params.policyId, req.valid.body));
    });
    r.post('/policies/:policyId/versions', { permission: 'monitoring.policy.manage', params: policyParams, body: publishBody, tags, summary: 'Publish new settings (a new immutable version)' }, async (req, res) => {
      sendCreated(res, await monitoringService.publishVersion(req.ctx, req.valid.params.policyId, req.valid.body));
    });
    r.get('/policies/:policyId/versions', { permission: 'monitoring.policy.read', params: policyParams, tags, summary: 'Version history of a policy' }, async (req, res) => {
      sendOk(res, await monitoringService.versions(req.ctx, req.valid.params.policyId));
    });
    r.put('/policies/:policyId/assignments', { permission: 'monitoring.policy.manage', params: policyParams, body: assignmentsBody, tags, summary: 'Replace the teams or employees a policy applies to' }, async (req, res) => {
      sendOk(res, await monitoringService.setAssignments(req.ctx, req.valid.params.policyId, req.valid.body.targets));
    });

    // ─── devices ────────────────────────────────────────────────────────────
    r.get('/agents', { permission: 'monitoring.agents.manage', query: employeeQuery, tags, summary: 'Connected desktop apps (mine or employees in scope)' }, async (req, res) => {
      sendOk(res, await monitoringService.listAgents(req.ctx, req.valid.query));
    });
    r.post('/agents/:agentId/revoke', { permission: 'monitoring.agents.manage', params: agentParams, tags, summary: 'Disconnect a desktop app' }, async (req, res) => {
      sendOk(res, await monitoringService.revokeAgent(req.ctx, req.valid.params.agentId));
    });

    // ─── desktop agent API (bearer token; see docs/screenshot-monitoring.md §4) ─
    r.post('/agent/register', { permission: PUBLIC, rateLimit: 'agent-auth', body: registerBody, tags: agentTags, summary: 'Pair a device with a one-time code and its Ed25519 public key' }, async (req, res) => {
      sendCreated(res, await monitoringService.registerAgent(req.ctx, req.valid.body));
    });
    r.post('/agent/challenge', { permission: PUBLIC, rateLimit: 'agent-auth', body: challengeBody, tags: agentTags, summary: 'One-time nonce for the device to sign' }, async (req, res) => {
      sendOk(res, await monitoringService.challenge(req.valid.body));
    });
    r.post('/agent/token', { permission: PUBLIC, rateLimit: 'agent-auth', body: tokenBody, tags: agentTags, summary: 'Exchange a signed nonce for a 15-minute access token' }, async (req, res) => {
      sendOk(res, await monitoringService.token(req.valid.body));
    });
    r.post('/agent/heartbeat', { permission: AGENT, rateLimit: 'agent', body: heartbeatBody, tags: agentTags, summary: 'Report device state; returns the capture permit' }, async (req, res) => {
      sendOk(res, await monitoringService.heartbeat(req.ctx, req.valid.body));
    });
    r.post('/agent/idle', { permission: AGENT, rateLimit: 'agent', body: idleBody, tags: agentTags, summary: 'Report idle intervals (durations only; only when the policy enables it)' }, async (req, res) => {
      sendOk(res, await monitoringService.recordIdle(req.ctx, req.valid.body));
    });
    r.post('/agent/uploads/presign', { permission: AGENT, rateLimit: 'agent', body: presignBody, tags: agentTags, summary: 'Register a capture and get a signed upload URL (idempotent per clientCaptureId)' }, async (req, res) => {
      sendOk(res, await monitoringService.presignUpload(req.ctx, req.valid.body));
    });
    r.post('/agent/uploads/complete', { permission: AGENT, rateLimit: 'agent', body: completeBody, tags: agentTags, summary: 'Confirm an upload; queues processing' }, async (req, res) => {
      sendOk(res, await monitoringService.completeUpload(req.ctx, req.valid.body));
    });
    r.post('/agent/uploads/fail', { permission: AGENT, rateLimit: 'agent', body: failBody, tags: agentTags, summary: 'Record a capture that will not be uploaded (for honest coverage)' }, async (req, res) => {
      sendOk(res, await monitoringService.failUpload(req.ctx, req.valid.body));
    });

    // ─── screenshots ────────────────────────────────────────────────────────
    r.get('/screenshots', { permission: 'monitoring.screenshots.read', query: listQuery, tags, summary: 'Screenshots in a time range (newest first)' }, async (req, res) => {
      const { items, nextCursor } = await monitoringService.listScreenshots(req.ctx, req.valid.query, cursorCodec);
      sendOk(res, items, { meta: { nextCursor } });
    });
    r.get('/timeline', { permission: 'monitoring.screenshots.read', query: timelineQuery, tags, summary: 'One day for one employee: sessions, breaks, captures and devices' }, async (req, res) => {
      sendOk(res, await monitoringService.timeline(req.ctx, req.valid.query));
    });
    r.post('/screenshots/access-urls', { permission: 'monitoring.screenshots.read', body: accessBody, tags, summary: 'Signed 60-second URLs; every view is logged' }, async (req, res) => {
      sendOk(res, await monitoringService.accessUrls(req.ctx, req.valid.body));
    });
    r.get('/screenshots/:screenshotId', { permission: 'monitoring.screenshots.read', params: shotParams, tags, summary: 'Screenshot details' }, async (req, res) => {
      sendOk(res, await monitoringService.getScreenshot(req.ctx, req.valid.params.screenshotId));
    });
    r.get('/screenshots/:screenshotId/access-log', { permission: 'monitoring.screenshots.read', params: shotParams, tags, summary: 'Who viewed or downloaded a screenshot' }, async (req, res) => {
      sendOk(res, await monitoringService.accessLog(req.ctx, req.valid.params.screenshotId));
    });
    r.delete('/screenshots/:screenshotId', { permission: 'monitoring.screenshots.delete', params: shotParams, tags, summary: 'Delete a screenshot (blocked under legal hold)' }, async (req, res) => {
      await monitoringService.deleteScreenshot(req.ctx, req.valid.params.screenshotId);
      sendNoContent(res);
    });
    r.get('/deletions', { permission: 'monitoring.screenshots.delete', query: deletionQuery, tags, summary: 'Deleted captures (metadata only)' }, async (req, res) => {
      sendOk(res, await monitoringService.deletionLog(req.ctx, req.valid.query));
    });

    // ─── legal holds ────────────────────────────────────────────────────────
    r.get('/legal-holds', { permission: 'monitoring.legalhold.manage', tags, summary: 'Legal holds' }, async (req, res) => {
      sendOk(res, await monitoringService.listHolds(req.ctx));
    });
    r.post('/legal-holds', { permission: 'monitoring.legalhold.manage', body: holdBody, tags, summary: 'Place a legal hold on members or projects' }, async (req, res) => {
      sendCreated(res, await monitoringService.createHold(req.ctx, req.valid.body));
    });
    r.post('/legal-holds/:holdId/release', { permission: 'monitoring.legalhold.manage', params: holdParams, tags, summary: 'Release a legal hold' }, async (req, res) => {
      sendOk(res, await monitoringService.releaseHold(req.ctx, req.valid.params.holdId));
    });
  });
}
