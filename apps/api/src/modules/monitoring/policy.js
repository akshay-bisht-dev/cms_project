import { sha256 } from '../../services/crypto.js';

/** Settings a new organization starts with: monitoring is OFF until an administrator turns it on. */
export const DEFAULT_POLICY_SETTINGS = Object.freeze({
  captureEnabled: false,
  intervalS: 600,
  minIntervalS: 300,
  maxIntervalS: 3600,
  blur: false,
  captureMode: 'ACTIVE_SCREEN',
  excludedApps: [],
  idleDetectionEnabled: false,
  retentionDays: 90,
  noticeText:
    'While you are clocked in and working, the Orbit desktop app takes periodic screenshots of your active screen. ' +
    'Nothing is captured while you are on a break or clocked out, and the tray icon always shows whether capture is on. ' +
    'Screenshots are visible to you and to the people listed on this page, and are deleted automatically when the retention period ends.',
});

/**
 * The hash a member acknowledges. It covers the notice text and every setting that changes what
 * is captured or kept, so any material change requires a fresh acknowledgement.
 */
export function noticeHashFor(v) {
  return sha256(
    JSON.stringify({
      noticeText: v.noticeText.trim(),
      captureEnabled: v.captureEnabled,
      intervalS: v.intervalS,
      blur: v.blur,
      captureMode: v.captureMode,
      excludedApps: [...v.excludedApps].sort(),
      idleDetectionEnabled: v.idleDetectionEnabled,
      retentionDays: v.retentionDays,
    }),
  );
}

/** Lower = less invasive. Used to break priority ties between team policies. */
function invasiveness(v) {
  return [v.captureEnabled ? 1 : 0, -v.intervalS, v.blur ? 0 : 1];
}

function compareCandidates(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const [x, y] = [invasiveness(a.version), invasiveness(b.version)];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return a.version.id < b.version.id ? -1 : 1;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Loads (creating on first use) the organization's single ORG policy with its current version. */
export async function ensureOrgPolicy(db, organizationId, publishedById) {
  const existing = await db.capturePolicy.findFirst({ where: { organizationId, scopeLevel: 'ORG' } });
  if (existing) return existing;
  try {
    const policy = await db.capturePolicy.create({
      data: { organizationId, name: 'Organization default', scopeLevel: 'ORG', orgSingleton: 'ORG', isActive: false },
    });
    const version = await db.monitoringPolicyVersion.create({
      data: { organizationId, policyId: policy.id, versionNo: 1, ...DEFAULT_POLICY_SETTINGS, noticeHash: noticeHashFor(DEFAULT_POLICY_SETTINGS), publishedById },
    });
    return db.capturePolicy.update({ where: { organizationId_id: { organizationId, id: policy.id } }, data: { currentVersionId: version.id } });
  } catch (err) {
    // A concurrent request created it first (unique org_singleton).
    if (err?.code !== 'P2002') throw err;
    return db.capturePolicy.findFirst({ where: { organizationId, scopeLevel: 'ORG' } });
  }
}

/**
 * The policy that governs a member right now (docs/screenshot-monitoring.md §3):
 * ORG master switch → MEMBER assignment → TEAM assignment (priority, then least invasive) → ORG.
 * The interval is clamped to the ORG bounds and retention can only be shortened below ORG.
 */
export async function resolveEffectivePolicy(db, organizationId, userId) {
  const orgPolicy = await db.capturePolicy.findFirst({ where: { organizationId, scopeLevel: 'ORG' } });
  if (!orgPolicy?.currentVersionId) return { enabled: false, reason: 'NOT_CONFIGURED', source: 'ORG', policy: null, version: null };
  const orgVersion = await db.monitoringPolicyVersion.findFirst({ where: { organizationId, id: orgPolicy.currentVersionId } });

  let chosen = { source: 'ORG', policy: orgPolicy, version: orgVersion };
  if (orgPolicy.isActive) {
    const teamIds = (await db.teamMember.findMany({ where: { organizationId, userId, team: { archivedAt: null } }, select: { teamId: true } })).map((t) => t.teamId);
    const assignments = await db.capturePolicyAssignment.findMany({
      where: {
        organizationId,
        policy: { isActive: true, currentVersionId: { not: null } },
        OR: [{ targetType: 'MEMBER', targetId: userId }, ...(teamIds.length ? [{ targetType: 'TEAM', targetId: { in: teamIds } }] : [])],
      },
      include: { policy: true },
    });
    if (assignments.length) {
      const versions = await db.monitoringPolicyVersion.findMany({ where: { organizationId, id: { in: assignments.map((a) => a.policy.currentVersionId) } } });
      const byId = new Map(versions.map((v) => [v.id, v]));
      const candidates = assignments.map((a) => ({ ...a, version: byId.get(a.policy.currentVersionId) })).filter((c) => c.version);
      const level = candidates.some((c) => c.targetType === 'MEMBER') ? 'MEMBER' : 'TEAM';
      const best = candidates.filter((c) => c.targetType === level).sort(compareCandidates)[0];
      if (best) chosen = { source: level, policy: best.policy, version: best.version };
    }
  }

  const v = chosen.version;
  const settings = {
    captureEnabled: orgPolicy.isActive && v.captureEnabled,
    intervalS: clamp(v.intervalS, orgVersion.minIntervalS, orgVersion.maxIntervalS),
    blur: v.blur,
    captureMode: v.captureMode,
    excludedApps: Array.isArray(v.excludedApps) ? v.excludedApps : [],
    idleDetectionEnabled: v.idleDetectionEnabled,
    retentionDays: Math.min(v.retentionDays, orgVersion.retentionDays),
  };
  return {
    enabled: settings.captureEnabled,
    reason: !orgPolicy.isActive ? 'MONITORING_OFF' : settings.captureEnabled ? null : 'POLICY_DISABLED',
    source: chosen.source,
    policy: chosen.policy,
    version: v,
    settings,
  };
}

/**
 * Consent state against the effective version: ACKNOWLEDGED only when the member's latest record
 * is an acknowledgement of the same notice hash.
 */
export async function consentState(db, organizationId, userId, effective) {
  const latest = await db.monitoringConsentRecord.findFirst({ where: { organizationId, userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!latest) return { status: 'REQUIRED', record: null };
  if (latest.action === 'WITHDRAWN') return { status: 'WITHDRAWN', record: latest };
  if (!effective?.version || latest.noticeHash !== effective.version.noticeHash) return { status: 'REQUIRED', record: latest };
  return { status: 'ACKNOWLEDGED', record: latest };
}

/** The consent record in force at an instant (for uploads captured earlier, while offline). */
export function consentAt(db, organizationId, userId, at) {
  return db.monitoringConsentRecord.findFirst({ where: { organizationId, userId, createdAt: { lte: at } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}
