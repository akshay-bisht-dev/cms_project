// Request/form shapes shared by web and api. Shape rules only — business rules live in api services.
import { z } from 'zod';
import { PAGINATION } from '@orbit/shared-constants';

export { z };

export const idSchema = z.uuid();

export const idParams = (name = 'id') => z.object({ [name]: idSchema }).strict();

export const emailSchema = z.email().max(254).transform((v) => v.toLowerCase());

export const passwordSchema = z.string().min(12, 'Use at least 12 characters').max(256);

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code');

export const timeZoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA time zone');

export const isoDateSchema = z.iso.date();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

const limitSchema = z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT);

export const cursorPageQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: limitSchema,
});

export const offsetPageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: limitSchema,
});

/** Parses `?sort=-createdAt,name` against an allow-list into [{ field, direction }]. */
export const sortQuery = (allowed) =>
  z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (!value) return [];
      return value.split(',').map((token) => {
        const direction = token.startsWith('-') ? 'desc' : 'asc';
        const field = token.replace(/^-/, '');
        if (!allowed.includes(field)) {
          ctx.addIssue({ code: 'custom', message: `Cannot sort by "${field}"` });
          return z.NEVER;
        }
        return { field, direction };
      });
    });

/** Money and quantities travel as strings so no float ever touches an amount. */
export const amountSchema = z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Use an amount such as 1250.00');
export const signedAmountSchema = z.string().trim().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'Use an amount such as 1250.00 (negative for a refund)');
export const quantitySchema = z.string().trim().regex(/^\d{1,8}(\.\d{1,4})?$/, 'Use a quantity such as 1.5');
/** Tax rate as a fraction: 0.18 = 18 %. */
export const taxRateSchema = z.string().trim().regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'Use a rate between 0 and 1, e.g. 0.18');
