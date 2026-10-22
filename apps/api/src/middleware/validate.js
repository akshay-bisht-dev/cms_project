import { ValidationError, zodIssuesToDetails } from '../utils/errors.js';

const LOCATIONS = ['params', 'query', 'body'];

/**
 * Validates req.params/query/body against Zod schemas and stores the parsed values on
 * `req.valid`. Express 5 makes req.query a getter, so parsed values are never written back.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const details = [];
    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (result.success) valid[location] = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues, location));
    }
    if (details.length) return next(new ValidationError(details));
    req.valid = valid;
    next();
  };
}
