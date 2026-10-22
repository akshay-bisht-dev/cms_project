import { currencySchema, emailSchema, passwordSchema, timeZoneSchema, z } from '@orbit/validation';
import { SETTINGS_SECTIONS } from './settings.js';

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3-48 lowercase letters, digits and dashes');

export const registerOrganizationBody = z
  .object({
    organizationName: z.string().trim().min(2).max(160),
    slug: slug.optional(),
    timeZone: timeZoneSchema.default('UTC'),
    baseCurrency: currencySchema.default('USD'),
    ownerName: z.string().trim().min(1).max(160),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const updateOrganizationBody = z
  .object({
    name: z.string().trim().min(2).max(160),
    timeZone: timeZoneSchema,
    baseCurrency: currencySchema,
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a locale such as en-US'),
    weekStart: z.number().int().min(1).max(7),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #6D4AE0').nullable(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

export const settingsSectionParams = z.object({ section: z.enum(SETTINGS_SECTIONS) }).strict();
