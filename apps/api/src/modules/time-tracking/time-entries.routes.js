import { idSchema, isoDateSchema, isoDateTimeSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';

const listQuery = z.object({ from: isoDateSchema, to: isoDateSchema, employeeId: idSchema.optional() }).strict().refine((q) => q.from <= q.to, { path: ['to'], message: 'from must be on or before to' });
const createBody = z
  .object({
    employeeId: idSchema.optional(),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema,
    description: z.string().trim().max(500).optional(),
    isBillable: z.boolean().default(false),
    projectId: idSchema.optional(),
    taskId: idSchema.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
const updateBody = z
  .object({
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema,
    description: z.string().trim().max(500).nullable(),
    isBillable: z.boolean(),
    projectId: idSchema.nullable(),
    taskId: idSchema.nullable(),
    reason: z.string().trim().max(500),
    version: z.number().int().min(0),
  })
  .partial()
  .strict();
const deleteBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const idParams = z.object({ entryId: idSchema }).strict();

export function timeEntryRoutes({ timeEntryService }) {
  const tags = ['Time tracking'];
  return defineRoutes('/time-entries', (r) => {
    r.get('/', { permission: 'time.read', apiKey: true, query: listQuery, tags, summary: 'Time entries in a date range (mine or an employee in scope)' }, async (req, res) => {
      const { items, totals, timeZone } = await timeEntryService.list(req.ctx, req.valid.query);
      sendOk(res, items, { meta: { totals, timeZone } });
    });
    r.post('/', { permission: 'time.read', body: createBody, idempotent: true, tags, summary: 'Add a manual time entry' }, async (req, res) => {
      sendCreated(res, await timeEntryService.create(req.ctx, req.valid.body));
    });
    r.patch('/:entryId', { permission: 'time.read', params: idParams, body: updateBody, tags, summary: 'Edit a time entry (revision recorded)' }, async (req, res) => {
      sendOk(res, await timeEntryService.update(req.ctx, req.valid.params.entryId, req.valid.body));
    });
    r.delete('/:entryId', { permission: 'time.read', params: idParams, body: deleteBody.optional(), tags, summary: 'Delete a time entry (revision recorded)' }, async (req, res) => {
      await timeEntryService.remove(req.ctx, req.valid.params.entryId, req.valid.body ?? {});
      sendNoContent(res);
    });
    r.get('/:entryId/revisions', { permission: 'time.read', params: idParams, tags, summary: 'Change history of a time entry' }, async (req, res) => {
      sendOk(res, await timeEntryService.revisions(req.ctx, req.valid.params.entryId));
    });
  });
}
