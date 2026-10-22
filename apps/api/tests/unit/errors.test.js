import { describe, expect, it } from 'vitest';
import { AppError, ConflictError, mapKnownError, NotFoundError, zodIssuesToDetails } from '../../src/utils/errors.js';

describe('mapKnownError', () => {
  it('passes AppErrors through unchanged', () => {
    const err = new NotFoundError();
    expect(mapKnownError(err)).toBe(err);
  });

  it.each([
    [{ code: 'P2002', meta: { target: 'users_email_key' } }, 409, 'CONFLICT'],
    [{ code: 'P2025' }, 404, 'NOT_FOUND'],
    [{ code: 'P2003' }, 409, 'CONFLICT'],
    [{ code: 'P2034' }, 409, 'VERSION_CONFLICT'],
    [{ type: 'entity.too.large' }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ type: 'entity.parse.failed' }, 400, 'VALIDATION_ERROR'],
  ])('maps %o to %i %s', (input, status, code) => {
    const mapped = mapKnownError(input);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
  });

  it('returns null for unknown errors so they become a generic 500', () => {
    expect(mapKnownError(new Error('db exploded: password=hunter2'))).toBeNull();
  });

  it('does not leak Prisma internals in conflict messages', () => {
    const mapped = mapKnownError({ code: 'P2002', message: 'Unique constraint failed on SELECT * FROM users' });
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped.message).not.toMatch(/SELECT/);
  });
});

describe('zodIssuesToDetails', () => {
  it('prefixes paths with the request location', () => {
    expect(zodIssuesToDetails([{ path: ['email'], message: 'Invalid email' }], 'body')).toEqual([
      { path: 'body.email', message: 'Invalid email' },
    ]);
  });
});
