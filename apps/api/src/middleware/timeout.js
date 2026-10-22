import { ERROR_CODES } from '@orbit/shared-constants';

/** Responds 503 if a handler has not finished within `ms`. The handler's late response is dropped. */
export function requestTimeout(ms) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      req.log?.warn({ timeoutMs: ms }, 'request timed out');
      res.status(503).json({
        success: false,
        error: { code: ERROR_CODES.TIMEOUT, message: 'The request took too long to complete', details: [] },
        requestId: req.id,
      });
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}
