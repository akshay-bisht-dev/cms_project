import { ERROR_CODES } from '@orbit/shared-constants';
import { NotFoundError, mapKnownError } from '../utils/errors.js';

export function notFoundHandler() {
  return (req, _res, next) => next(new NotFoundError(`No route for ${req.method} ${req.path}`));
}

/** Central error handler. Only AppErrors reach the client; everything else becomes a generic 500. */
export function errorHandler() {
  // Express identifies error handlers by arity, so all four parameters are required.
  return (err, req, res, _next) => {
    const known = mapKnownError(err);
    const status = known?.status ?? 500;

    if (status >= 500) req.log?.error({ err }, 'unhandled error');
    else req.log?.info({ code: known.code, status }, 'request rejected');

    if (res.headersSent) return;

    res.status(status).json({
      success: false,
      error: known
        ? { code: known.code, message: known.message, details: known.details ?? [] }
        : { code: ERROR_CODES.INTERNAL_ERROR, message: 'An unexpected error occurred', details: [] },
      requestId: req.id,
    });
  };
}
