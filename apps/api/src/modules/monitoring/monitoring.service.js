import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueOutbox } from '../../services/outbox.js';
import { sha256 } from '../../services/crypto.js';
import { withTransaction } from '../../repositories/tx.js';
import { localDateRange, memberTimeZone, overlapping } from '../../utils/time.js';
import { coversMember, hasOrgScope, resolveMemberScope } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { offboardingHooks } from '../employees/employees.service.js';
import { markStatsDirty, recordActivity } from '../activity/activity.js';
import { workTime } from '../activity/kpi.js';
import { DEFAULT_POLICY_SETTINGS, consentAt, consentState, ensureOrgPolicy, noticeHashFor, resolveEffectivePolicy } from './policy.js';
import {
  PAIRING_TTL_S,
  challengeExpired,
  challengeMessage,
  createAgentTokens,
  createChallenge,
  generatePairingCode,
  normalizePairingCode,
  parsePublicKey,
  timestampFresh,
  verifyAgentSignature,
} from './agent-auth.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_DIMENSION = 8192;
export const UPLOAD_TYPES = Object.freeze({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' });
/** Permits expire after two missed heartbeats; an offline agent then pauses (§5). */
export const PERMIT_TTL_S = 120;
/** The agent queue keeps captures for up to 72 h; anything older is refused. */
const MAX_CAPTURE_AGE_MS = 73 * 3600 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

const notPermitted = (message, reason) => new BusinessRuleError(message, ERROR_CODES.CAPTURE_NOT_PERMITTED, [{ path: 'reason', message: reason }]);

function versionSettings(v) {
  return {
    captureEnabled: v.captureEnabled,
    intervalS: v.intervalS,
    minIntervalS: v.minIntervalS,
    maxIntervalS: v.maxIntervalS,
    blur: v.blur,
    captureMode: v.captureMode,
    excludedApps: Array.isArray(v.excludedApps) ? v.excludedApps : [],
    idleDetectionEnabled: v.idleDetectionEnabled,
    retentionDays: v.retentionDays,
    noticeText: v.noticeText,
  };
}

const serializeVersion = (v) => v && { id: v.id, versionNo: v.versionNo, ...versionSettings(v), noticeHash: v.noticeHash, publishedAt: v.publishedAt };

function serializeAgent(a) {
  return {
    id: a.id,
    deviceName: a.deviceName,
    os: a.os,
    osVersion: a.osVersion,
    agentVersion: a.agentVersion,
    status: a.status,
    lastSeenAt: a.lastSeenAt,
    lastState: a.lastState ?? null,
    registeredAt: a.registeredAt,
    revokedAt: a.revokedAt,
  };
}

function storagePath(prefix, organizationId, capturedAt, id, ext) {
  const iso = capturedAt.toISOString();
  return `${prefix}/${organizationId}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${id}.${ext}`;
}

export const tmpKeyFor = (s) => storagePath('tmp', s.organizationId, s.capturedAt, s.id, UPLOAD_TYPES[s.mimeType] ?? 'bin');

/** Where-clause for the screenshots a legal-hold target covers. Hold dates are UTC calendar dates. */
function holdTargetWhere(organizationId, target) {
  const where = { organizationId, ...(target.targetType === 'MEMBER' ? { userId: target.targetId } : { projectId: target.targetId }) };
  if (target.fromDate || target.toDate) {
    where.capturedAt = {};
    if (target.fromDate) where.capturedAt.gte = target.fromDate;
    if (target.toDate) where.capturedAt.lt = new Date(target.toDate.getTime() + 86400_000);
  }
  return where;
}

/** Whether an active legal hold covers a capture (checked when a row is created). */
async function isUnderHold(db, organizationId, { userId, projectId, capturedAt }) {
  const targets = await db.legalHoldTarget.findMany({
    where: {
      organizationId,
      hold: { releasedAt: null },
      OR: [{ targetType: 'MEMBER', targetId: userId }, ...(projectId ? [{ targetType: 'PROJECT', targetId: projectId }] : [])],
    },
  });
  return targets.some((t) => (!t.fromDate || capturedAt >= t.fromDate) && (!t.toDate || capturedAt < new Date(t.toDate.getTime() + 86400_000)));
}

/** Revokes every active agent of a member in one organization. */
export async function revokeMemberAgents(db, organizationId, userId, revokedById, now) {
  return db.desktopAgent.updateMany({
    where: { organizationId, userId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: now, revokedById, lastNonceHash: null },
  });
}

// Offboarding disconnects the member's desktop apps (their captures follow normal retention).
offboardingHooks.push((tx, ctx, member) => revokeMemberAgents(tx, ctx.orgId, member.userId, ctx.userId, new Date()));

export function createMonitoringService({ prisma, clock, env, storage, cipher }) {
  const agentTokens = createAgentTokens(env.SESSION_SECRET, clock);
  const notifyOpts = { cipher, appOrigin: env.APP_ORIGIN };

  // ─── policies ─────────────────────────────────────────────────────────────

  function validateSettings(scopeLevel, s, orgVersion) {
    const details = [];
    if (s.minIntervalS > s.maxIntervalS) details.push({ path: 'body.minIntervalS', message: 'The minimum interval must not exceed the maximum' });
    if (scopeLevel === 'ORG' && (s.intervalS < s.minIntervalS || s.intervalS > s.maxIntervalS)) {
      details.push({ path: 'body.intervalS', message: 'The interval must be within the minimum and maximum' });
    }
    if (scopeLevel !== 'ORG' && orgVersion && s.retentionDays > orgVersion.retentionDays) {
      details.push({ path: 'body.retentionDays', message: `Retention cannot exceed the organization's ${orgVersion.retentionDays} days` });
    }
    if (details.length) throw new ValidationError(details);
  }

  async function loadPolicy(db, ctx, policyId) {
    const policy = await db.capturePolicy.findFirst({ where: { organizationId: ctx.orgId, id: policyId } });
    if (!policy) throw new NotFoundError('Policy not found');
    return policy;
  }

  async function orgVersionOf(db, organizationId) {
    const org = await ensureOrgPolicy(db, organizationId, null);
    return db.monitoringPolicyVersion.findFirst({ where: { organizationId, id: org.currentVersionId } });
  }

  async function serializePolicies(db, ctx, policies) {
    const versionIds = policies.map((p) => p.currentVersionId).filter(Boolean);
    const [versions, assignments] = await Promise.all([
      db.monitoringPolicyVersion.findMany({ where: { organizationId: ctx.orgId, id: { in: versionIds } } }),
      db.capturePolicyAssignment.findMany({ where: { organizationId: ctx.orgId, policyId: { in: policies.map((p) => p.id) } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const teamIds = assignments.filter((a) => a.targetType === 'TEAM').map((a) => a.targetId);
    const [teams, members] = await Promise.all([
      teamIds.length ? db.team.findMany({ where: { organizationId: ctx.orgId, id: { in: teamIds } }, select: { id: true, name: true } }) : [],
      memberSummaries(db, ctx.orgId, assignments.filter((a) => a.targetType === 'MEMBER').map((a) => a.targetId)),
    ]);
    const teamNames = new Map(teams.map((t) => [t.id, t.name]));
    const versionById = new Map(versions.map((v) => [v.id, v]));
    return policies.map((p) => ({
      id: p.id,
      name: p.name,
      scopeLevel: p.scopeLevel,
      isActive: p.isActive,
      currentVersion: serializeVersion(versionById.get(p.currentVersionId)),
      assignments: assignments
        .filter((a) => a.policyId === p.id)
        .map((a) =>
          a.targetType === 'TEAM'
            ? { type: 'TEAM', id: a.targetId, name: teamNames.get(a.targetId) ?? 'Unknown team', priority: a.priority }
            : { type: 'MEMBER', id: members.get(a.targetId)?.employeeId ?? null, name: members.get(a.targetId)?.name ?? 'Unknown', priority: a.priority },
        ),
      updatedAt: p.updatedAt,
    }));
  }

  async function publishVersionTx(tx, ctx, policy, settings) {
    const last = await tx.monitoringPolicyVersion.findFirst({ where: { organizationId: ctx.orgId, policyId: policy.id }, orderBy: { versionNo: 'desc' } });
    const data = { ...settings, noticeText: settings.noticeText.trim(), excludedApps: [...new Set(settings.excludedApps.map((a) => a.trim()).filter(Boolean))] };
    const version = await tx.monitoringPolicyVersion.create({
      data: { organizationId: ctx.orgId, policyId: policy.id, versionNo: (last?.versionNo ?? 0) + 1, ...data, noticeHash: noticeHashFor(data), publishedById: ctx.userId, publishedAt: clock.now() },
    });
    await tx.capturePolicy.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: policy.id } }, data: { currentVersionId: version.id } });
    return version;
  }

  // ─── screenshots: visibility helpers ─────────────────────────────────────

  async function loadVisibleScreenshot(db, ctx, screenshotId) {
    const shot = await db.screenshot.findFirst({ where: { organizationId: ctx.orgId, id: screenshotId, status: { not: 'DELETED' } } });
    if (!shot || !(await coversMember(db, ctx, 'monitoring.screenshots.read', shot.userId))) throw new NotFoundError('Screenshot not found');
    return shot;
  }

  async function serializeScreenshots(db, ctx, shots) {
    const projectIds = [...new Set(shots.map((s) => s.projectId).filter(Boolean))];
    const taskIds = [...new Set(shots.map((s) => s.taskId).filter(Boolean))];
    const versionIds = [...new Set(shots.map((s) => s.policyVersionId))];
    const [members, projects, tasks, versions] = await Promise.all([
      memberSummaries(db, ctx.orgId, shots.map((s) => s.userId)),
      projectIds.length ? db.project.findMany({ where: { organizationId: ctx.orgId, id: { in: projectIds } }, select: { id: true, code: true, name: true } }) : [],
      taskIds.length ? db.task.findMany({ where: { organizationId: ctx.orgId, id: { in: taskIds } }, select: { id: true, number: true, title: true, projectId: true } }) : [],
      db.monitoringPolicyVersion.findMany({ where: { organizationId: ctx.orgId, id: { in: versionIds } }, select: { id: true, intervalS: true, blur: true } }),
    ]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const versionById = new Map(versions.map((v) => [v.id, v]));
    return shots.map((s) => {
      const member = members.get(s.userId);
      const project = projectById.get(s.projectId);
      const task = taskById.get(s.taskId);
      return {
        id: s.id,
        employee: member ? { id: member.employeeId, name: member.name } : null,
        capturedAt: s.capturedAt,
        uploadedAt: s.uploadedAt,
        status: s.status,
        failureCode: s.failureCode,
        width: s.width,
        height: s.height,
        sizeBytes: s.sizeBytes,
        project: project ? { id: project.id, code: project.code, name: project.name } : null,
        task: task ? { id: task.id, key: `${projectById.get(task.projectId)?.code ?? ''}-${task.number}`, title: task.title } : null,
        workSessionId: s.workSessionId,
        policy: versionById.has(s.policyVersionId) ? { versionId: s.policyVersionId, intervalS: versionById.get(s.policyVersionId).intervalS, blur: versionById.get(s.policyVersionId).blur } : null,
        retentionExpiresAt: s.retentionExpiresAt,
        legalHold: s.legalHold,
        own: s.userId === ctx.userId,
      };
    });
  }

  /** Deletes the stored objects, then the metadata (only after the objects are gone). */
  async function deleteScreenshot(db, ctx, shot, reason) {
    for (const key of [shot.storageKey, shot.thumbKey, shot.status === 'PENDING_UPLOAD' || shot.status === 'UPLOADED' ? tmpKeyFor(shot) : null]) {
      if (key) await storage.remove({ bucket: storage.buckets.captures, key });
    }
    const now = clock.now();
    await withTransaction(prisma, async (tx) => {
      const { count } = await tx.screenshot.updateMany({
        where: { organizationId: shot.organizationId, id: shot.id, legalHold: false, status: { not: 'DELETED' } },
        data: { status: 'DELETED', storageKey: null, thumbKey: null, deletedAt: now },
      });
      if (count === 0) return;
      await tx.screenshotDeletionLog.create({
        data: { organizationId: shot.organizationId, screenshotId: shot.id, userId: shot.userId, capturedAt: shot.capturedAt, actorId: ctx?.userId ?? null, reason, createdAt: now },
      });
      if (ctx?.userId) {
        await recordAudit(tx, ctx, { action: 'monitoring.screenshot_deleted', targetType: 'screenshot', targetId: shot.id, diff: { capturedAt: shot.capturedAt, reason } });
      }
    });
  }

  // ─── agent capture checks ─────────────────────────────────────────────────

  /** The server's answer to "may this agent capture right now?" (§5: the server is authoritative). */
  async function capturePermit(db, ctx) {
    const now = clock.now();
    const effective = await resolveEffectivePolicy(db, ctx.orgId, ctx.userId);
    const consent = await consentState(db, ctx.orgId, ctx.userId, effective);
    const state = await db.memberWorkState.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } } });

    let reason = null;
    if (!effective.enabled) reason = effective.reason;
    else if (consent.status !== 'ACKNOWLEDGED') reason = consent.status === 'WITHDRAWN' ? 'CONSENT_WITHDRAWN' : 'CONSENT_REQUIRED';
    else if (!state || state.state === 'OFF') reason = 'CLOCKED_OUT';
    else if (state.state === 'ON_BREAK') reason = 'ON_BREAK';

    const settings = effective.settings ?? null;
    return {
      capture: reason === null,
      reason,
      workState: state?.state ?? 'OFF',
      policyVersionId: effective.version?.id ?? null,
      noticeHash: effective.version?.noticeHash ?? null,
      consent: consent.status,
      intervalS: settings?.intervalS ?? null,
      blur: settings?.blur ?? false,
      captureMode: settings?.captureMode ?? 'ACTIVE_SCREEN',
      excludedApps: settings?.excludedApps ?? [],
      idleDetectionEnabled: settings?.idleDetectionEnabled ?? false,
      permitExpiresAt: new Date(now.getTime() + PERMIT_TTL_S * 1000).toISOString(),
      serverTime: now.toISOString(),
    };
  }

  /**
   * Verifies a capture the agent wants to upload was allowed when it was taken: the member had
   * acknowledged exactly that policy version, it enabled capture, and they were working (in a
   * session, not on a break). Returns the session and the project/task the timer was tracking.
   */
  async function assertCaptureWasPermitted(db, ctx, { capturedAt, policyVersionId }) {
    const now = clock.now();
    if (capturedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) throw new ValidationError([{ path: 'body.capturedAt', message: 'capturedAt is in the future' }]);
    if (now.getTime() - capturedAt.getTime() > MAX_CAPTURE_AGE_MS) throw notPermitted('This capture is too old to upload', 'EXPIRED');

    const version = await db.monitoringPolicyVersion.findFirst({ where: { organizationId: ctx.orgId, id: policyVersionId } });
    if (!version) throw new ValidationError([{ path: 'body.policyVersionId', message: 'Unknown policy version' }]);
    if (!version.captureEnabled || version.publishedAt > capturedAt) throw notPermitted('That policy did not allow capture at this time', 'POLICY_DISABLED');

    const consent = await consentAt(db, ctx.orgId, ctx.userId, capturedAt);
    if (consent?.action !== 'ACKNOWLEDGED' || consent.noticeHash !== version.noticeHash) {
      throw new BusinessRuleError('The monitoring notice had not been acknowledged when this was captured', ERROR_CODES.CONSENT_REQUIRED);
    }

    const session = await db.workSession.findFirst({
      where: { organizationId: ctx.orgId, userId: ctx.userId, startedAt: { lte: capturedAt }, OR: [{ endedAt: null }, { endedAt: { gte: capturedAt } }] },
    });
    if (!session) throw notPermitted('Captures are only accepted while clocked in', 'OUTSIDE_WORK_SESSION');
    const onBreak = await db.breakSession.findFirst({
      where: { organizationId: ctx.orgId, workSessionId: session.id, startedAt: { lte: capturedAt }, OR: [{ endedAt: null }, { endedAt: { gt: capturedAt } }] },
    });
    if (onBreak) throw notPermitted('Captures are not accepted during breaks', 'ON_BREAK');

    const entry = await db.timeEntry.findFirst({
      where: { organizationId: ctx.orgId, userId: ctx.userId, deletedAt: null, startedAt: { lte: capturedAt }, OR: [{ endedAt: null }, { endedAt: { gt: capturedAt } }] },
      select: { projectId: true, taskId: true },
    });
    return { version, session, projectId: entry?.projectId ?? null, taskId: entry?.taskId ?? null };
  }

  async function presignFor(shot) {
    return storage.presignPut({ bucket: storage.buckets.captures, key: tmpKeyFor(shot), contentType: shot.mimeType, contentLength: shot.sizeBytes });
  }

  return {
    agentTokens,
    capturePermit,

    // ─── policies ───────────────────────────────────────────────────────────

    async listPolicies(ctx) {
      if (!hasOrgScope(ctx, 'monitoring.policy.read')) throw new ForbiddenError('You can only view your own monitoring policy');
      await ensureOrgPolicy(prisma, ctx.orgId, ctx.userId);
      const policies = await prisma.capturePolicy.findMany({ where: { organizationId: ctx.orgId }, orderBy: [{ scopeLevel: 'asc' }, { name: 'asc' }] });
      return serializePolicies(prisma, ctx, policies);
    },

    async createPolicy(ctx, { name, scopeLevel, settings }) {
      const orgVersion = await orgVersionOf(prisma, ctx.orgId);
      const merged = { ...versionSettings(orgVersion), ...settings, minIntervalS: orgVersion.minIntervalS, maxIntervalS: orgVersion.maxIntervalS };
      validateSettings(scopeLevel, merged, orgVersion);
      const policy = await withTransaction(prisma, async (tx) => {
        const created = await tx.capturePolicy.create({ data: { organizationId: ctx.orgId, name, scopeLevel } });
        const version = await publishVersionTx(tx, ctx, created, merged);
        await recordAudit(tx, ctx, { action: 'monitoring.policy_created', targetType: 'capture_policy', targetId: created.id, diff: { name, scopeLevel, versionNo: version.versionNo } });
        return { ...created, currentVersionId: version.id };
      });
      return (await serializePolicies(prisma, ctx, [policy]))[0];
    },

    async updatePolicy(ctx, policyId, { name, isActive }) {
      const policy = await loadPolicy(prisma, ctx, policyId);
      const updated = await withTransaction(prisma, async (tx) => {
        const row = await tx.capturePolicy.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: policy.id } },
          data: { ...(name !== undefined ? { name } : {}), ...(isActive !== undefined ? { isActive } : {}) },
        });
        await recordAudit(tx, ctx, { action: 'monitoring.policy_updated', targetType: 'capture_policy', targetId: policy.id, diff: { before: { name: policy.name, isActive: policy.isActive }, after: { name: row.name, isActive: row.isActive } } });
        return row;
      });
      return (await serializePolicies(prisma, ctx, [updated]))[0];
    },

    /** Publishes a new immutable version; screenshots keep pointing at the version that governed them. */
    async publishVersion(ctx, policyId, settings) {
      const policy = await loadPolicy(prisma, ctx, policyId);
      const orgVersion = policy.scopeLevel === 'ORG' ? null : await orgVersionOf(prisma, ctx.orgId);
      const merged = policy.scopeLevel === 'ORG' ? settings : { ...settings, minIntervalS: orgVersion.minIntervalS, maxIntervalS: orgVersion.maxIntervalS };
      validateSettings(policy.scopeLevel, merged, orgVersion);
      const updated = await withTransaction(prisma, async (tx) => {
        const version = await publishVersionTx(tx, ctx, policy, merged);
        await recordAudit(tx, ctx, { action: 'monitoring.policy_published', targetType: 'capture_policy', targetId: policy.id, diff: { versionNo: version.versionNo, ...versionSettings(version) } });
        return { ...policy, currentVersionId: version.id };
      });
      return (await serializePolicies(prisma, ctx, [updated]))[0];
    },

    async versions(ctx, policyId) {
      if (!hasOrgScope(ctx, 'monitoring.policy.read')) throw new ForbiddenError();
      const policy = await loadPolicy(prisma, ctx, policyId);
      const rows = await prisma.monitoringPolicyVersion.findMany({ where: { organizationId: ctx.orgId, policyId: policy.id }, orderBy: { versionNo: 'desc' } });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.publishedById));
      return rows.map((v) => ({ ...serializeVersion(v), publishedBy: people.get(v.publishedById)?.name ?? null }));
    },

    async setAssignments(ctx, policyId, targets) {
      const policy = await loadPolicy(prisma, ctx, policyId);
      if (policy.scopeLevel === 'ORG') throw new BusinessRuleError('The organization policy applies to everyone and has no assignments');
      const wrongType = targets.find((t) => t.type !== policy.scopeLevel);
      if (wrongType) throw new ValidationError([{ path: 'body.targets', message: `A ${policy.scopeLevel.toLowerCase()} policy can only be assigned to ${policy.scopeLevel === 'TEAM' ? 'teams' : 'employees'}` }]);

      const rows = [];
      for (const [i, t] of targets.entries()) {
        if (t.type === 'TEAM') {
          const team = await prisma.team.findFirst({ where: { organizationId: ctx.orgId, id: t.id, archivedAt: null } });
          if (!team) throw new ValidationError([{ path: `body.targets.${i}.id`, message: 'Team not found' }]);
          rows.push({ targetType: 'TEAM', targetId: team.id, priority: t.priority });
        } else {
          rows.push({ targetType: 'MEMBER', targetId: await resolveEmployeeUserId(prisma, ctx.orgId, t.id, `body.targets.${i}.id`), priority: t.priority });
        }
      }
      await withTransaction(prisma, async (tx) => {
        await tx.capturePolicyAssignment.deleteMany({ where: { organizationId: ctx.orgId, policyId: policy.id } });
        if (rows.length) await tx.capturePolicyAssignment.createMany({ data: rows.map((r) => ({ organizationId: ctx.orgId, policyId: policy.id, ...r })), skipDuplicates: true });
        await recordAudit(tx, ctx, { action: 'monitoring.policy_assigned', targetType: 'capture_policy', targetId: policy.id, diff: { targets: rows } });
      });
      return (await serializePolicies(prisma, ctx, [policy]))[0];
    },

    async effectiveFor(ctx, employeeId) {
      const userId = employeeId ? await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId') : ctx.userId;
      if (!(await coversMember(prisma, ctx, 'monitoring.policy.read', userId))) throw new ForbiddenError('You cannot view this person’s monitoring policy');
      const effective = await resolveEffectivePolicy(prisma, ctx.orgId, userId);
      const consent = await consentState(prisma, ctx.orgId, userId, effective);
      return {
        enabled: effective.enabled,
        reason: effective.reason,
        source: effective.source,
        policy: effective.policy ? { id: effective.policy.id, name: effective.policy.name } : null,
        version: serializeVersion(effective.version),
        settings: effective.settings ?? null,
        consent: consent.status,
      };
    },

    // ─── the employee's own view ────────────────────────────────────────────

    /** Everything the /monitoring page shows the employee about their own monitoring. */
    async me(ctx) {
      await ensureOrgPolicy(prisma, ctx.orgId, ctx.userId);
      const effective = await resolveEffectivePolicy(prisma, ctx.orgId, ctx.userId);
      const consent = await consentState(prisma, ctx.orgId, ctx.userId, effective);
      const since = new Date(clock.now().getTime() - 7 * 86400_000);
      const [agents, counts, viewerRoles, history] = await Promise.all([
        prisma.desktopAgent.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId }, orderBy: { registeredAt: 'desc' } }),
        prisma.screenshot.groupBy({ by: ['status'], where: { organizationId: ctx.orgId, userId: ctx.userId, capturedAt: { gte: since } }, _count: { _all: true } }),
        prisma.rolePermission.findMany({
          where: { organizationId: ctx.orgId, permissionKey: 'monitoring.screenshots.read' },
          select: { scope: true, role: { select: { name: true } } },
        }),
        prisma.monitoringConsentRecord.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
      ]);
      return {
        enabled: effective.enabled,
        reason: effective.reason,
        source: effective.source,
        version: serializeVersion(effective.version),
        settings: effective.settings ?? null,
        consent: { status: consent.status, at: consent.record?.createdAt ?? null },
        consentHistory: history.map((h) => ({ action: h.action, at: h.createdAt, policyVersionId: h.policyVersionId })),
        // Who can see screenshots: role names and how far their access reaches.
        viewers: viewerRoles.map((r) => ({ role: r.role.name, scope: r.scope.toLowerCase() })),
        agents: agents.map(serializeAgent),
        last7Days: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      };
    },

    async recordConsent(ctx, { action, policyVersionId }) {
      const effective = await resolveEffectivePolicy(prisma, ctx.orgId, ctx.userId);
      if (!effective.version) throw new BusinessRuleError('Monitoring has not been configured for your organization');
      if (action === 'ACKNOWLEDGED' && policyVersionId !== effective.version.id) {
        throw new ConflictError('The monitoring notice has changed; please review the current version', ERROR_CODES.VERSION_CONFLICT);
      }
      const now = clock.now();
      await withTransaction(prisma, async (tx) => {
        await tx.monitoringConsentRecord.create({
          data: {
            organizationId: ctx.orgId,
            userId: ctx.userId,
            policyVersionId: effective.version.id,
            action,
            noticeHash: effective.version.noticeHash,
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent?.slice(0, 512) ?? null,
            createdAt: now,
          },
        });
        await recordAudit(tx, ctx, { action: action === 'ACKNOWLEDGED' ? 'monitoring.notice_acknowledged' : 'monitoring.consent_withdrawn', targetType: 'policy_version', targetId: effective.version.id });
      });
      return this.me(ctx);
    },

    async createPairingCode(ctx) {
      const code = generatePairingCode();
      const expiresAt = new Date(clock.now().getTime() + PAIRING_TTL_S * 1000);
      await withTransaction(prisma, async (tx) => {
        // Only the newest code works.
        await tx.agentPairingCode.deleteMany({ where: { organizationId: ctx.orgId, userId: ctx.userId, usedAt: null } });
        await tx.agentPairingCode.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, codeHash: sha256(code), expiresAt } });
      });
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    },

    async listAgents(ctx, { employeeId }) {
      let where = { organizationId: ctx.orgId };
      if (employeeId) {
        const userId = await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId');
        if (!(await coversMember(prisma, ctx, 'monitoring.agents.manage', userId))) throw new ForbiddenError();
        where.userId = userId;
      } else {
        const scope = await resolveMemberScope(prisma, ctx, 'monitoring.agents.manage');
        if (!scope.all) where = { ...where, userId: { in: [...scope.userIds] } };
      }
      const agents = await prisma.desktopAgent.findMany({ where, orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }], take: 500 });
      const people = await memberSummaries(prisma, ctx.orgId, agents.map((a) => a.userId));
      return agents.map((a) => ({ ...serializeAgent(a), employee: people.has(a.userId) ? { id: people.get(a.userId).employeeId, name: people.get(a.userId).name } : null }));
    },

    async revokeAgent(ctx, agentId) {
      const agent = await prisma.desktopAgent.findFirst({ where: { organizationId: ctx.orgId, id: agentId } });
      if (!agent || !(await coversMember(prisma, ctx, 'monitoring.agents.manage', agent.userId))) throw new NotFoundError('Device not found');
      if (agent.status === 'REVOKED') return serializeAgent(agent);
      const now = clock.now();
      await withTransaction(prisma, async (tx) => {
        await tx.desktopAgent.updateMany({ where: { organizationId: ctx.orgId, id: agent.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedById: ctx.userId, lastNonceHash: null } });
        await recordAudit(tx, ctx, { action: 'monitoring.agent_revoked', targetType: 'desktop_agent', targetId: agent.id, diff: { deviceName: agent.deviceName } });
        if (agent.userId !== ctx.userId) {
          await notify(tx, ctx, {
            ...notifyOpts,
            organizationId: ctx.orgId,
            recipientUserId: agent.userId,
            type: 'monitoring.agent_revoked',
            title: `${agent.deviceName} was disconnected`,
            body: `${ctx.user.name} disconnected this device from your account.`,
            link: '/monitoring',
            subjectType: 'desktop_agent',
            subjectId: agent.id,
            dedupeKey: `agent-revoked:${agent.id}`,
          });
        }
      });
      return serializeAgent({ ...agent, status: 'REVOKED', revokedAt: now, revokedById: ctx.userId });
    },

    // ─── agent authentication ───────────────────────────────────────────────

    async registerAgent(meta, { pairingCode, publicKey, deviceName, os, osVersion, agentVersion }) {
      parsePublicKey(publicKey);
      const invalid = new UnauthenticatedError('That pairing code is invalid or has expired', ERROR_CODES.INVALID_TOKEN);
      const code = await prisma.agentPairingCode.findUnique({ where: { codeHash: sha256(normalizePairingCode(pairingCode)) } });
      if (!code || code.usedAt || code.expiresAt <= clock.now()) throw invalid;

      const result = await withTransaction(prisma, async (tx) => {
        const now = clock.now();
        const { count } = await tx.agentPairingCode.updateMany({ where: { organizationId: code.organizationId, id: code.id, usedAt: null }, data: { usedAt: now } });
        if (count === 0) throw invalid;
        const member = await tx.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: code.organizationId, userId: code.userId } },
          include: { organization: true, user: { select: { name: true } } },
        });
        if (member?.status !== 'ACTIVE' || !['ACTIVE', 'TRIAL'].includes(member.organization.status)) throw invalid;
        const agent = await tx.desktopAgent.create({
          data: { organizationId: code.organizationId, userId: code.userId, deviceName, os, osVersion: osVersion ?? null, agentVersion: agentVersion ?? null, publicKey, registeredAt: now },
        });
        const ctx = { ...meta, orgId: code.organizationId, userId: code.userId };
        await recordAudit(tx, ctx, { action: 'monitoring.agent_registered', targetType: 'desktop_agent', targetId: agent.id, diff: { deviceName, os } });
        await notify(tx, null, {
          ...notifyOpts,
          organizationId: code.organizationId,
          recipientUserId: code.userId,
          type: 'monitoring.agent_paired',
          title: `${deviceName} was connected to your account`,
          body: 'If this was not you, disconnect it from the Monitoring page and change your password.',
          link: '/monitoring',
          subjectType: 'desktop_agent',
          subjectId: agent.id,
          dedupeKey: `agent-paired:${agent.id}`,
        });
        return { agent, member };
      });
      const { agent, member } = result;
      return {
        agentId: agent.id,
        ...agentTokens.issue({ agentId: agent.id, organizationId: agent.organizationId, userId: agent.userId }),
        organization: { id: member.organization.id, name: member.organization.name },
        member: { name: member.user.name },
      };
    },

    /** Issues a one-time nonce; only the latest one is valid (its hash is stored on the agent). */
    async challenge({ agentId }) {
      const agent = await prisma.unscoped.desktopAgent.findUnique({ where: { id: agentId } });
      if (!agent) throw new UnauthenticatedError('Unknown device', ERROR_CODES.INVALID_TOKEN);
      if (agent.status !== 'ACTIVE') throw new UnauthenticatedError('This device has been disconnected', ERROR_CODES.AGENT_REVOKED);
      const { nonce, nonceHash, expiresAt } = createChallenge(clock);
      await prisma.desktopAgent.updateMany({ where: { organizationId: agent.organizationId, id: agent.id, status: 'ACTIVE' }, data: { lastNonceHash: nonceHash } });
      return { nonce, expiresAt };
    },

    /** Exchanges a signed challenge for a short-lived access token. */
    async token({ agentId, nonce, ts, signature }) {
      const invalid = new UnauthenticatedError('The signed challenge was not accepted', ERROR_CODES.INVALID_TOKEN);
      const agent = await prisma.unscoped.desktopAgent.findUnique({ where: { id: agentId } });
      if (!agent) throw invalid;
      if (agent.status !== 'ACTIVE') throw new UnauthenticatedError('This device has been disconnected', ERROR_CODES.AGENT_REVOKED);
      if (challengeExpired(nonce, clock) || !timestampFresh(ts, clock)) throw invalid;
      if (!verifyAgentSignature(agent.publicKey, challengeMessage({ agentId, nonce, ts }), signature)) throw invalid;
      // Consume the nonce atomically: a replayed signature finds it already cleared.
      const { count } = await prisma.desktopAgent.updateMany({
        where: { organizationId: agent.organizationId, id: agent.id, status: 'ACTIVE', lastNonceHash: sha256(nonce) },
        data: { lastNonceHash: null },
      });
      if (count === 0) throw invalid;
      const member = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: agent.organizationId, userId: agent.userId } } });
      if (member?.status !== 'ACTIVE') throw new UnauthenticatedError('This device has been disconnected', ERROR_CODES.AGENT_REVOKED);
      return agentTokens.issue({ agentId: agent.id, organizationId: agent.organizationId, userId: agent.userId });
    },

    async heartbeat(ctx, { state, queueDepth, queueBytes, osPermission, lastError, agentVersion }) {
      const now = clock.now();
      await prisma.desktopAgent.updateMany({
        where: { organizationId: ctx.orgId, id: ctx.agent.id },
        data: { lastSeenAt: now, agentVersion: agentVersion ?? ctx.agent.agentVersion, lastState: { state, queueDepth, queueBytes, osPermission, lastError: lastError ?? null, at: now.toISOString() } },
      });
      const permit = await capturePermit(prisma, ctx);
      const member = ctx.member;
      return { ...permit, member: { name: ctx.user.name }, organization: { id: member.organization.id, name: member.organization.name } };
    },

    /**
     * Idle intervals reported by the agent (FR-ACT-4): only durations without keyboard or mouse
     * input, never what was typed. Accepted only while the member's policy enables idle detection
     * and they have acknowledged it; clipped to their working time (not breaks). Idempotent by id.
     */
    async recordIdle(ctx, { intervals }) {
      const effective = await resolveEffectivePolicy(prisma, ctx.orgId, ctx.userId);
      const consent = await consentState(prisma, ctx.orgId, ctx.userId, effective);
      if (!effective.enabled || !effective.settings.idleDetectionEnabled || consent.status !== 'ACKNOWLEDGED') {
        throw notPermitted('Idle detection is not enabled for you', 'IDLE_DISABLED');
      }
      const now = clock.now();
      let recorded = 0;
      for (const interval of intervals) {
        const start = new Date(interval.startedAt);
        const end = new Date(interval.endedAt);
        if (end <= start || end.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS || now.getTime() - start.getTime() > MAX_CAPTURE_AGE_MS) continue;
        const seen = await prisma.activityEvent.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, type: 'agent.idle', subjectId: interval.id, occurredAt: { gte: new Date(start.getTime() - 86_400_000), lte: end } } });
        if (seen) continue;
        const sessions = await prisma.workSession.findMany({
          where: { organizationId: ctx.orgId, userId: ctx.userId, ...overlapping(start, end) },
          include: { breaks: true },
        });
        const { workedIntervals } = workTime(sessions, now);
        await withTransaction(prisma, async (tx) => {
          for (const piece of workedIntervals) {
            const s = Math.max(piece.start.getTime(), start.getTime());
            const e = Math.min(piece.end.getTime(), end.getTime());
            if (e - s < 1000) continue;
            await recordActivity(tx, { organizationId: ctx.orgId, userId: ctx.userId, type: 'agent.idle', occurredAt: new Date(s), durationS: Math.floor((e - s) / 1000), subjectType: 'idle_interval', subjectId: interval.id, metadata: { agentId: ctx.agent.id } });
            recorded += 1;
          }
        });
      }
      return { recorded };
    },

    // ─── uploads ────────────────────────────────────────────────────────────

    async presignUpload(ctx, body) {
      const capturedAt = new Date(body.capturedAt);
      const unique = { organizationId_agentId_clientCaptureId: { organizationId: ctx.orgId, agentId: ctx.agent.id, clientCaptureId: body.clientCaptureId } };
      let shot = await prisma.screenshot.findUnique({ where: unique });

      if (!shot) {
        const permitted = await assertCaptureWasPermitted(prisma, ctx, { capturedAt, policyVersionId: body.policyVersionId });
        const legalHold = await isUnderHold(prisma, ctx.orgId, { userId: ctx.userId, projectId: permitted.projectId, capturedAt });
        try {
          shot = await prisma.screenshot.create({
            data: {
              organizationId: ctx.orgId,
              userId: ctx.userId,
              agentId: ctx.agent.id,
              workSessionId: permitted.session.id,
              projectId: permitted.projectId,
              taskId: permitted.taskId,
              policyVersionId: permitted.version.id,
              clientCaptureId: body.clientCaptureId,
              capturedAt,
              mimeType: body.mimeType,
              width: body.width,
              height: body.height,
              sizeBytes: body.sizeBytes,
              sha256: body.sha256,
              legalHold,
              createdAt: clock.now(),
            },
          });
        } catch (err) {
          if (err?.code !== 'P2002') throw err;
          shot = await prisma.screenshot.findUnique({ where: unique });
        }
      }

      // A retry must describe the same capture.
      if (shot.sha256 && shot.sha256 !== body.sha256) {
        throw new ConflictError('This capture id was already used for different content', ERROR_CODES.IDEMPOTENCY_MISMATCH);
      }
      if (shot.status === 'PENDING_UPLOAD') return { screenshotId: shot.id, status: shot.status, upload: await presignFor(shot) };
      if (['UPLOADED', 'READY'].includes(shot.status)) return { screenshotId: shot.id, status: shot.status, upload: null };
      throw new ConflictError(`This capture was already recorded as ${shot.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
    },

    async completeUpload(ctx, { screenshotId }) {
      const shot = await prisma.screenshot.findFirst({ where: { organizationId: ctx.orgId, id: screenshotId, agentId: ctx.agent.id } });
      if (!shot) throw new NotFoundError('Screenshot not found');
      if (shot.status !== 'PENDING_UPLOAD') {
        if (['UPLOADED', 'READY'].includes(shot.status)) return { screenshotId: shot.id, status: shot.status };
        throw new ConflictError(`This capture was recorded as ${shot.status.toLowerCase()}`, ERROR_CODES.INVALID_STATE_TRANSITION);
      }
      const key = tmpKeyFor(shot);
      const head = await storage.head({ bucket: storage.buckets.captures, key });
      if (!head) throw new BusinessRuleError('The upload has not finished yet');
      if (head.contentLength !== shot.sizeBytes || (head.contentType && head.contentType !== shot.mimeType)) {
        await storage.remove({ bucket: storage.buckets.captures, key }).catch(() => {});
        await prisma.screenshot.updateMany({ where: { organizationId: ctx.orgId, id: shot.id, status: 'PENDING_UPLOAD' }, data: { status: 'REJECTED', failureCode: 'UPLOAD_MISMATCH' } });
        await markStatsDirty(prisma, ctx.orgId, ctx.userId, [shot.capturedAt]);
        throw new BusinessRuleError('The uploaded file does not match what was declared');
      }
      await withTransaction(prisma, async (tx) => {
        const { count } = await tx.screenshot.updateMany({ where: { organizationId: ctx.orgId, id: shot.id, status: 'PENDING_UPLOAD' }, data: { status: 'UPLOADED', uploadedAt: clock.now() } });
        if (count === 0) return;
        await markStatsDirty(tx, ctx.orgId, ctx.userId, [shot.capturedAt]);
        await enqueueOutbox(tx, { type: 'screenshot.process', payload: { organizationId: ctx.orgId, screenshotId: shot.id }, dedupeKey: `screenshot.process:${shot.id}`, organizationId: ctx.orgId });
      });
      return { screenshotId: shot.id, status: 'UPLOADED' };
    },

    /** Records a capture that will never arrive, so coverage reports explain the gap honestly. */
    async failUpload(ctx, { clientCaptureId, capturedAt, policyVersionId, code }) {
      const version = await prisma.monitoringPolicyVersion.findFirst({ where: { organizationId: ctx.orgId, id: policyVersionId } });
      if (!version) throw new ValidationError([{ path: 'body.policyVersionId', message: 'Unknown policy version' }]);
      const unique = { organizationId_agentId_clientCaptureId: { organizationId: ctx.orgId, agentId: ctx.agent.id, clientCaptureId } };
      const existing = await prisma.screenshot.findUnique({ where: unique });
      if (existing) {
        if (existing.status === 'PENDING_UPLOAD') {
          await prisma.screenshot.updateMany({ where: { organizationId: ctx.orgId, id: existing.id, status: 'PENDING_UPLOAD' }, data: { status: 'FAILED', failureCode: code } });
          await markStatsDirty(prisma, ctx.orgId, ctx.userId, [existing.capturedAt]);
          await storage.remove({ bucket: storage.buckets.captures, key: tmpKeyFor(existing) }).catch(() => {});
          return { screenshotId: existing.id, status: 'FAILED' };
        }
        return { screenshotId: existing.id, status: existing.status };
      }
      const at = new Date(capturedAt);
      if (at.getTime() > clock.now().getTime() + MAX_FUTURE_SKEW_MS) throw new ValidationError([{ path: 'body.capturedAt', message: 'capturedAt is in the future' }]);
      try {
        const shot = await prisma.screenshot.create({
          data: { organizationId: ctx.orgId, userId: ctx.userId, agentId: ctx.agent.id, policyVersionId: version.id, clientCaptureId, capturedAt: at, status: 'FAILED', failureCode: code, createdAt: clock.now() },
        });
        await markStatsDirty(prisma, ctx.orgId, ctx.userId, [at]);
        return { screenshotId: shot.id, status: 'FAILED' };
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
        const shot = await prisma.screenshot.findUnique({ where: unique });
        return { screenshotId: shot.id, status: shot.status };
      }
    },

    // ─── gallery ────────────────────────────────────────────────────────────

    async listScreenshots(ctx, { employeeId, projectId, from, to, status, cursor, limit }, cursorCodec) {
      const where = { organizationId: ctx.orgId, capturedAt: { gte: new Date(from), lt: new Date(to) }, status: status ? { in: status } : { notIn: ['DELETED', 'PENDING_UPLOAD'] } };
      if (employeeId) {
        const userId = await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId');
        if (!(await coversMember(prisma, ctx, 'monitoring.screenshots.read', userId))) throw new ForbiddenError('You cannot view this person’s screenshots');
        where.userId = userId;
      } else {
        const scope = await resolveMemberScope(prisma, ctx, 'monitoring.screenshots.read');
        if (!scope.all) where.userId = { in: [...scope.userIds] };
      }
      if (projectId) where.projectId = projectId;
      if (cursor) {
        const c = cursorCodec.decode(cursor, 'capturedAt');
        where.AND = [{ OR: [{ capturedAt: { lt: new Date(c.capturedAt) } }, { capturedAt: new Date(c.capturedAt), id: { lt: c.id } }] }];
      }
      const rows = await prisma.screenshot.findMany({ where, orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await serializeScreenshots(prisma, ctx, page),
        nextCursor: rows.length > limit && last ? cursorCodec.encode({ sort: 'capturedAt', capturedAt: last.capturedAt.toISOString(), id: last.id }) : null,
      };
    },

    /** One member's day: sessions, breaks, captures (including failures) and devices, so gaps can be explained. */
    async timeline(ctx, { employeeId, date }) {
      const userId = employeeId ? await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId') : ctx.userId;
      if (!(await coversMember(prisma, ctx, 'monitoring.screenshots.read', userId))) throw new ForbiddenError('You cannot view this person’s screenshots');
      const profile = await prisma.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId } }, select: { timeZone: true } });
      const timeZone = memberTimeZone(profile?.timeZone, ctx.organization?.timeZone);
      const [start, end] = localDateRange(date, date, timeZone);
      const [sessions, shots, agents, effective] = await Promise.all([
        prisma.workSession.findMany({
          where: { organizationId: ctx.orgId, userId, ...overlapping(start, end) },
          include: { breaks: { orderBy: { startedAt: 'asc' } } },
          orderBy: { startedAt: 'asc' },
        }),
        prisma.screenshot.findMany({ where: { organizationId: ctx.orgId, userId, capturedAt: { gte: start, lt: end }, status: { not: 'DELETED' } }, orderBy: { capturedAt: 'asc' }, take: 2000 }),
        prisma.desktopAgent.findMany({ where: { organizationId: ctx.orgId, userId }, orderBy: { registeredAt: 'desc' } }),
        resolveEffectivePolicy(prisma, ctx.orgId, userId),
      ]);
      const people = await memberSummaries(prisma, ctx.orgId, [userId]);
      return {
        employee: { id: people.get(userId)?.employeeId ?? null, name: people.get(userId)?.name ?? null },
        date,
        timeZone,
        window: { start, end },
        monitoring: { enabled: effective.enabled, reason: effective.reason, intervalS: effective.settings?.intervalS ?? null },
        sessions: sessions.map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, breaks: s.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt })) })),
        screenshots: await serializeScreenshots(prisma, ctx, shots),
        agents: agents.map(serializeAgent),
      };
    },

    /**
     * Short-lived signed URLs (60 s). Each view is written to the access log before a URL is
     * issued. Downloads need the separate download permission for that member.
     */
    async accessUrls(ctx, { ids, variant }) {
      const shots = await prisma.screenshot.findMany({ where: { organizationId: ctx.orgId, id: { in: ids }, status: 'READY' } });
      const permission = variant === 'download' ? 'monitoring.screenshots.download' : 'monitoring.screenshots.read';
      const visible = [];
      for (const shot of shots) if (await coversMember(prisma, ctx, 'monitoring.screenshots.read', shot.userId)) visible.push(shot);
      const allowed = [];
      for (const shot of visible) if (await coversMember(prisma, ctx, permission, shot.userId)) allowed.push(shot);
      if (ids.length === 1 && visible.length === 0) throw new NotFoundError('Screenshot not found');
      if (ids.length === 1 && allowed.length === 0) throw new ForbiddenError('You cannot download this screenshot');
      const action = { thumb: 'VIEW_THUMB', full: 'VIEW', download: 'DOWNLOAD' }[variant];
      const now = clock.now();
      if (allowed.length) {
        await prisma.screenshotAccessLog.createMany({ data: allowed.map((s) => ({ organizationId: ctx.orgId, screenshotId: s.id, actorId: ctx.userId, action, ip: ctx.ip ?? null, at: now })) });
      }
      const urls = [];
      for (const shot of allowed) {
        const key = variant === 'thumb' ? shot.thumbKey : shot.storageKey;
        const fileName = `screenshot-${shot.capturedAt.toISOString().replace(/[:.]/g, '-')}.webp`;
        const signed = await storage.presignGet({ bucket: storage.buckets.captures, key, fileName, inline: variant !== 'download' });
        urls.push({ id: shot.id, url: signed.url, expiresAt: signed.expiresAt });
      }
      return urls;
    },

    async getScreenshot(ctx, screenshotId) {
      const shot = await loadVisibleScreenshot(prisma, ctx, screenshotId);
      const [item] = await serializeScreenshots(prisma, ctx, [shot]);
      return {
        ...item,
        canDownload: shot.status === 'READY' && (await coversMember(prisma, ctx, 'monitoring.screenshots.download', shot.userId)),
        canDelete: hasOrgScope(ctx, 'monitoring.screenshots.delete') && !shot.legalHold,
        canViewAccessLog: shot.userId === ctx.userId || hasOrgScope(ctx, 'monitoring.screenshots.delete'),
      };
    },

    /** Access history: visible to the person in the screenshot and to those who may delete captures. */
    async accessLog(ctx, screenshotId) {
      const shot = await loadVisibleScreenshot(prisma, ctx, screenshotId);
      if (shot.userId !== ctx.userId && !hasOrgScope(ctx, 'monitoring.screenshots.delete')) throw new ForbiddenError('You cannot view who accessed this screenshot');
      const rows = await prisma.screenshotAccessLog.findMany({ where: { organizationId: ctx.orgId, screenshotId: shot.id }, orderBy: { at: 'desc' }, take: 200 });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.actorId));
      return rows.map((r) => ({ at: r.at, action: r.action, actor: { id: people.get(r.actorId)?.employeeId ?? null, name: people.get(r.actorId)?.name ?? 'Former member' } }));
    },

    async deleteScreenshot(ctx, screenshotId) {
      const shot = await prisma.screenshot.findFirst({ where: { organizationId: ctx.orgId, id: screenshotId, status: { not: 'DELETED' } } });
      if (!shot) throw new NotFoundError('Screenshot not found');
      if (shot.legalHold) throw new ConflictError('This screenshot is under a legal hold and cannot be deleted', ERROR_CODES.LEGAL_HOLD);
      await deleteScreenshot(prisma, ctx, shot, 'MANUAL');
    },

    async deletionLog(ctx, { from, to }) {
      const rows = await prisma.screenshotDeletionLog.findMany({ where: { organizationId: ctx.orgId, createdAt: { gte: new Date(from), lt: new Date(to) } }, orderBy: { createdAt: 'desc' }, take: 500 });
      const people = await memberSummaries(prisma, ctx.orgId, rows.flatMap((r) => [r.userId, r.actorId]));
      return rows.map((r) => ({
        screenshotId: r.screenshotId,
        employee: { id: people.get(r.userId)?.employeeId ?? null, name: people.get(r.userId)?.name ?? 'Former member' },
        capturedAt: r.capturedAt,
        deletedAt: r.createdAt,
        reason: r.reason,
        actor: r.actorId ? { name: people.get(r.actorId)?.name ?? 'Former member' } : null,
      }));
    },

    // ─── legal holds ────────────────────────────────────────────────────────

    async listHolds(ctx) {
      const holds = await prisma.legalHold.findMany({ where: { organizationId: ctx.orgId }, include: { targets: true }, orderBy: { createdAt: 'desc' } });
      const memberIds = holds.flatMap((h) => h.targets.filter((t) => t.targetType === 'MEMBER').map((t) => t.targetId));
      const projectIds = holds.flatMap((h) => h.targets.filter((t) => t.targetType === 'PROJECT').map((t) => t.targetId));
      const [people, projects, counts] = await Promise.all([
        memberSummaries(prisma, ctx.orgId, [...memberIds, ...holds.map((h) => h.createdById)]),
        projectIds.length ? prisma.project.findMany({ where: { organizationId: ctx.orgId, id: { in: projectIds } }, select: { id: true, code: true, name: true } }) : [],
        prisma.screenshot.count({ where: { organizationId: ctx.orgId, legalHold: true, status: { not: 'DELETED' } } }),
      ]);
      const projectById = new Map(projects.map((p) => [p.id, p]));
      return {
        heldScreenshots: counts,
        holds: holds.map((h) => ({
          id: h.id,
          name: h.name,
          reason: h.reason,
          createdAt: h.createdAt,
          createdBy: people.get(h.createdById)?.name ?? null,
          releasedAt: h.releasedAt,
          targets: h.targets.map((t) => ({
            type: t.targetType,
            id: t.targetType === 'MEMBER' ? (people.get(t.targetId)?.employeeId ?? null) : t.targetId,
            name: t.targetType === 'MEMBER' ? (people.get(t.targetId)?.name ?? 'Former member') : (projectById.get(t.targetId)?.name ?? 'Unknown project'),
            fromDate: t.fromDate,
            toDate: t.toDate,
          })),
        })),
      };
    },

    async createHold(ctx, { name, reason, targets }) {
      const rows = [];
      for (const [i, t] of targets.entries()) {
        const targetId =
          t.type === 'MEMBER'
            ? await resolveEmployeeUserId(prisma, ctx.orgId, t.id, `body.targets.${i}.id`)
            : (await prisma.project.findFirst({ where: { organizationId: ctx.orgId, id: t.id }, select: { id: true } }))?.id;
        if (!targetId) throw new ValidationError([{ path: `body.targets.${i}.id`, message: 'Project not found' }]);
        rows.push({ targetType: t.type, targetId, fromDate: t.fromDate ? new Date(`${t.fromDate}T00:00:00.000Z`) : null, toDate: t.toDate ? new Date(`${t.toDate}T00:00:00.000Z`) : null });
      }
      const hold = await withTransaction(prisma, async (tx) => {
        const created = await tx.legalHold.create({ data: { organizationId: ctx.orgId, name, reason, createdById: ctx.userId, createdAt: clock.now() } });
        await tx.legalHoldTarget.createMany({ data: rows.map((r) => ({ organizationId: ctx.orgId, holdId: created.id, ...r })) });
        let held = 0;
        for (const r of rows) {
          held += (await tx.screenshot.updateMany({ where: { ...holdTargetWhere(ctx.orgId, r), status: { not: 'DELETED' }, legalHold: false }, data: { legalHold: true } })).count;
        }
        await recordAudit(tx, ctx, { action: 'monitoring.legal_hold_created', targetType: 'legal_hold', targetId: created.id, diff: { name, targets: rows, held } });
        return created;
      });
      return { id: hold.id };
    },

    /** Releases a hold and recomputes the cached flag: rows stay held if another active hold covers them. */
    async releaseHold(ctx, holdId) {
      const hold = await prisma.legalHold.findFirst({ where: { organizationId: ctx.orgId, id: holdId }, include: { targets: true } });
      if (!hold) throw new NotFoundError('Legal hold not found');
      if (hold.releasedAt) return { id: hold.id, releasedAt: hold.releasedAt };
      const now = clock.now();
      await withTransaction(prisma, async (tx) => {
        await tx.legalHold.updateMany({ where: { organizationId: ctx.orgId, id: hold.id, releasedAt: null }, data: { releasedAt: now, releasedById: ctx.userId } });
        for (const t of hold.targets) {
          await tx.screenshot.updateMany({ where: { ...holdTargetWhere(ctx.orgId, t), legalHold: true }, data: { legalHold: false } });
        }
        const remaining = await tx.legalHoldTarget.findMany({ where: { organizationId: ctx.orgId, hold: { releasedAt: null } } });
        for (const t of remaining) {
          await tx.screenshot.updateMany({ where: { ...holdTargetWhere(ctx.orgId, t), status: { not: 'DELETED' }, legalHold: false }, data: { legalHold: true } });
        }
        await recordAudit(tx, ctx, { action: 'monitoring.legal_hold_released', targetType: 'legal_hold', targetId: hold.id, diff: { name: hold.name } });
      });
      return { id: hold.id, releasedAt: now };
    },

    defaults: DEFAULT_POLICY_SETTINGS,
  };
}
