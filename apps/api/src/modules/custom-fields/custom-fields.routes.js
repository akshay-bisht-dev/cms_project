import { idSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { sendCreated, sendOk } from '../../utils/response.js';

const entity = z.enum(['EMPLOYEE', 'PROJECT', 'TASK', 'CLIENT', 'TICKET']);
const fieldBody = z
  .object({
    entity,
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Use lowercase letters, digits and _ (start with a letter)'),
    label: z.string().trim().min(1).max(120),
    type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN']),
    options: z.array(z.string().trim().min(1).max(80)).max(100),
    required: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();
const valueParams = z.object({ entity, entityId: idSchema }).strict();
const value = z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.string().max(80)).max(100), z.null()]);

export function customFieldRoutes({ customFieldService }) {
  const tags = ['Custom fields'];
  return defineRoutes('/custom-fields', (r) => {
    r.get('/', { permission: MEMBER, apiKey: true, query: z.object({ entity: entity.optional(), includeArchived: z.enum(['true', 'false']).optional() }).strict(), tags, summary: 'Field definitions' }, async (req, res) => {
      sendOk(res, await customFieldService.definitions(req.ctx, { entity: req.valid.query.entity, includeArchived: req.valid.query.includeArchived === 'true' }));
    });
    r.post('/', { permission: 'customfields.manage', body: fieldBody.required({ entity: true, key: true, label: true, type: true }), tags, summary: 'Define a field' }, async (req, res) => {
      sendCreated(res, await customFieldService.saveDefinition(req.ctx, null, req.valid.body));
    });
    r.patch('/:fieldId', { permission: 'customfields.manage', params: z.object({ fieldId: idSchema }).strict(), body: fieldBody.omit({ entity: true, key: true, type: true }).extend({ archived: z.boolean().optional() }), tags, summary: 'Rename, reorder, change options or archive' }, async (req, res) => {
      sendOk(res, await customFieldService.saveDefinition(req.ctx, req.valid.params.fieldId, req.valid.body));
    });
    r.get('/values/:entity/:entityId', { permission: MEMBER, apiKey: true, params: valueParams, tags, summary: 'Values for a record (needs read access to it; meta.canEdit says whether you may set them)' }, async (req, res) => {
      const { entity, entityId } = req.valid.params;
      const values = await customFieldService.values(req.ctx, entity, entityId);
      sendOk(res, values, { meta: { canEdit: await customFieldService.canEdit(req.ctx, entity, entityId) } });
    });
    r.put('/values/:entity/:entityId', { permission: MEMBER, params: valueParams, body: z.object({ values: z.record(z.string(), value) }).strict(), tags, summary: 'Set values by key (needs edit access to the record)' }, async (req, res) => {
      sendOk(res, await customFieldService.setValues(req.ctx, req.valid.params.entity, req.valid.params.entityId, req.valid.body.values));
    });
  });
}
