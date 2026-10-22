import { ERROR_CODES } from '@orbit/shared-constants';
import { ConflictError, ValidationError } from '../utils/errors.js';
import { sha256 } from '../services/crypto.js';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const TTL_MS = 24 * 3600 * 1000;

/**
 * Idempotency-Key support for critical mutations. The first request stores its response;
 * retries with the same key and body replay it; the same key with a different body is rejected.
 * A request still in flight answers 409 so clients retry later. 5xx responses are not stored.
 */
export function idempotency({ prisma, clock }) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key || !KEY_PATTERN.test(key)) {
      return next(new ValidationError([{ path: 'headers.idempotency-key', message: 'An Idempotency-Key header (8-128 characters) is required' }]));
    }
    const { orgId: organizationId, userId } = req.ctx;
    const methodPath = `${req.method} ${req.baseUrl}${req.path}`.slice(0, 255);
    const requestHash = sha256(JSON.stringify({ methodPath, body: req.body ?? null }));
    const where = { organizationId_userId_key: { organizationId, userId, key } };

    const existing = await prisma.idempotencyKey.findUnique({ where });
    if (existing && existing.expiresAt > clock.now()) {
      if (existing.requestHash !== requestHash) {
        return next(new ConflictError('This Idempotency-Key was used with a different request', ERROR_CODES.IDEMPOTENCY_MISMATCH));
      }
      if (existing.responseStatus === null) {
        return next(new ConflictError('A request with this Idempotency-Key is still being processed'));
      }
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(existing.responseStatus).json(existing.responseBody);
    }
    if (existing) await prisma.idempotencyKey.deleteMany({ where: { organizationId, userId, key } });

    try {
      await prisma.idempotencyKey.create({
        data: { organizationId, userId, key, methodPath, requestHash, expiresAt: new Date(clock.now().getTime() + TTL_MS) },
      });
    } catch (err) {
      if (err?.code === 'P2002') return next(new ConflictError('A request with this Idempotency-Key is still being processed'));
      throw err;
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const persist =
        status < 500
          ? prisma.idempotencyKey.updateMany({ where: { organizationId, userId, key }, data: { responseStatus: status, responseBody: body } })
          : prisma.idempotencyKey.deleteMany({ where: { organizationId, userId, key } });
      persist.catch((err) => req.log?.error({ err }, 'failed to persist idempotency record')).finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
