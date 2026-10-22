import { hmac, safeEqual } from '../services/crypto.js';
import { ValidationError } from './errors.js';

/**
 * Opaque, tamper-evident keyset cursors: base64url(JSON) + "." + HMAC. Clients cannot craft
 * cursors to probe arbitrary sort positions or change the sort they were issued for.
 */
export function createCursorCodec(secret) {
  return {
    encode(value) {
      const body = Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${body}.${hmac(secret, `cursor:${body}`)}`;
    },
    decode(cursor, expectedSort) {
      const [body, signature] = String(cursor).split('.');
      if (!body || !signature || !safeEqual(signature, hmac(secret, `cursor:${body}`))) {
        throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor' }]);
      }
      let value;
      try {
        value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor' }]);
      }
      if (expectedSort && value.sort !== expectedSort) {
        throw new ValidationError([{ path: 'query.cursor', message: 'Cursor does not match the requested sort' }]);
      }
      return value;
    },
  };
}
