import { randomUUID } from 'node:crypto';

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a well-formed upstream X-Request-Id (from Nginx) or generates one. */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
