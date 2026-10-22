import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/config/logger.js';

function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk));
      done();
    },
  });
  // The same redaction settings createLogger uses.
  return { lines, logger: pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream) };
}

describe('log redaction', () => {
  it('never writes credentials, session material or sensitive profile fields', () => {
    const { lines, logger } = capture();
    logger.info({
      req: { method: 'POST', url: '/api/v1/auth/login', headers: { authorization: 'Bearer orb_abc_secret', cookie: 'orbit_sid=s3cret', 'x-csrf-token': 'csrf-value', 'user-agent': 'test' } },
      res: { statusCode: 200, headers: { 'set-cookie': ['orbit_sid=new-secret'] } },
      body: { email: 'a@b.test', password: 'Correct-Horse-1' },
      user: { passwordHash: '$argon2id$…', personalEmail: 'me@home.test', emergencyContact: { name: 'X' } },
      webhook: { secret: 'whsec' },
      invite: { token: 'tok' },
    }, 'request');
    const text = JSON.stringify(lines[0]);
    for (const leaked of ['orb_abc_secret', 's3cret', 'csrf-value', 'new-secret', 'Correct-Horse-1', '$argon2id$', 'me@home.test', 'whsec', '"tok"']) {
      expect(text).not.toContain(leaked);
    }
    // Non-sensitive context stays readable.
    expect(lines[0].req.headers['user-agent']).toBe('test');
    expect(lines[0].body.email).toBe('a@b.test');
  });
});
