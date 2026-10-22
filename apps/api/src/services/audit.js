const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = /password|token|secret|personalEmail|address|emergencyContact|recovery/i;

/** Replaces values of sensitive keys anywhere in a diff with a marker. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? REDACTED : redact(v)]));
  }
  return value;
}

/**
 * Writes an audit record. Pass the transaction client so the audit row commits or rolls back
 * together with the change it describes.
 */
export function recordAudit(db, ctx, { action, targetType = null, targetId = null, diff = null, organizationId, actorType }) {
  return db.auditLog.create({
    data: {
      organizationId: organizationId === undefined ? (ctx?.orgId ?? null) : organizationId,
      actorType: actorType ?? (ctx?.apiKey ? 'API_KEY' : ctx?.userId ? 'USER' : 'SYSTEM'),
      // An API key's actions are attributed to the key (its creator is in the key's own record).
      actorId: ctx?.apiKey?.id ?? ctx?.userId ?? null,
      action,
      targetType,
      targetId,
      diff: diff ? redact(diff) : undefined,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent?.slice(0, 512) ?? null,
      requestId: ctx?.requestId ?? null,
    },
  });
}
