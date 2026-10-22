import { ERROR_CODES } from '@orbit/shared-constants';

/** Base class for errors that are safe to show to API clients. */
export class AppError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export class ValidationError extends AppError {
  constructor(details = [], message = 'The request is invalid') {
    super(400, ERROR_CODES.VALIDATION_ERROR, message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required', code = ERROR_CODES.UNAUTHENTICATED) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = ERROR_CODES.FORBIDDEN) {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found') {
    super(404, ERROR_CODES.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The request conflicts with the current state', code = ERROR_CODES.CONFLICT, details = []) {
    super(409, code, message, details);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message, code = ERROR_CODES.BUSINESS_RULE_VIOLATION, details = []) {
    super(422, code, message, details);
  }
}

export class UnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable', details = []) {
    super(503, ERROR_CODES.UNAVAILABLE, message, details);
  }
}

/** Converts a ZodError's issues into the public `details` format. */
export function zodIssuesToDetails(issues, location) {
  return issues.map((issue) => ({
    path: [location, ...issue.path].filter((p) => p !== undefined && p !== '').join('.'),
    message: issue.message,
  }));
}

/**
 * Maps known infrastructure errors (Prisma, body-parser) to AppErrors.
 * Returns null for unknown errors, which become a generic 500.
 */
export function mapKnownError(err) {
  if (err instanceof AppError) return err;

  // body-parser / express.json
  if (err?.type === 'entity.too.large') {
    return new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'The request body is too large');
  }
  if (err?.type === 'entity.parse.failed') {
    return new ValidationError([{ path: 'body', message: 'Malformed JSON' }]);
  }

  // Prisma known request errors
  switch (err?.code) {
    case 'P2002':
      return new ConflictError('A record with these values already exists', ERROR_CODES.CONFLICT, [
        { path: String(err.meta?.target ?? ''), message: 'must be unique' },
      ]);
    case 'P2025':
      return new NotFoundError();
    case 'P2003':
      return new ConflictError('A related record is missing or still in use');
    case 'P2034':
      return new ConflictError('The record was modified concurrently; please retry', ERROR_CODES.VERSION_CONFLICT);
    default:
      return null;
  }
}
