import { Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { isoDate } from '../../utils/time.js';
import { coversMember, hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { loadProject } from '../projects/access.js';
import { loadReadableClient } from '../crm/crm.service.js';
import { ticketScopeWhere } from '../tickets/tickets.service.js';

/**
 * Custom field values live with their entity, so access follows the entity's own rules:
 * reading needs read access to the record, writing needs edit access.
 */
const ACCESS = {
  async EMPLOYEE(db, ctx, entityId, write) {
    const member = await db.organizationMember.findFirst({ where: { organizationId: ctx.orgId, id: entityId, memberType: 'EMPLOYEE' } });
    if (!member || !(await coversMember(db, ctx, 'employees.read', member.userId))) throw new NotFoundError('Employee not found');
    if (write && !hasOrgScope(ctx, 'employees.create')) throw new ForbiddenError('You cannot edit this employee’s custom fields');
  },
  async PROJECT(db, ctx, entityId, write) {
    await loadProject(db, ctx, entityId, write ? 'canManage' : 'canRead');
  },
  async TASK(db, ctx, entityId, write) {
    const task = await db.task.findFirst({ where: { organizationId: ctx.orgId, id: entityId } });
    if (!task) throw new NotFoundError('Task not found');
    await loadProject(db, ctx, task.projectId, write ? 'canEditTasks' : 'canReadTasks');
  },
  async CLIENT(db, ctx, entityId, write) {
    await loadReadableClient(db, ctx, entityId);
    if (write && !hasPermission(ctx, 'clients.manage')) throw new ForbiddenError('You cannot edit this client');
  },
  async TICKET(db, ctx, entityId, write) {
    const where = await ticketScopeWhere(db, ctx, write ? 'tickets.manage' : 'tickets.read');
    if (!(await db.supportTicket.findFirst({ where: { AND: [where, { id: entityId }] }, select: { id: true } }))) throw new NotFoundError('Ticket not found');
  },
};

const serializeField = (f) => ({ id: f.id, entity: f.entity, key: f.key, label: f.label, type: f.type, options: f.options ?? [], required: f.required, sortOrder: f.sortOrder, archived: Boolean(f.archivedAt) });

function readValue(field, v) {
  if (!v) return null;
  switch (field.type) {
    case 'NUMBER':
      return v.valueNumber === null ? null : v.valueNumber.toString();
    case 'DATE':
      return v.valueDate ? isoDate(v.valueDate) : null;
    case 'BOOLEAN':
      return v.valueText === null ? null : v.valueText === 'true';
    case 'MULTI_SELECT':
      return v.valueJson ?? [];
    default:
      return v.valueText;
  }
}

/** Validates and converts one value into its storage columns (null clears it). */
function toColumns(field, value, path) {
  const fail = (message) => {
    throw new ValidationError([{ path, message }]);
  };
  const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) {
    if (field.required) fail(`${field.label} is required`);
    return null;
  }
  const options = field.options ?? [];
  switch (field.type) {
    case 'TEXT':
      if (typeof value !== 'string' || value.length > 1000) fail('Use text up to 1000 characters');
      return { valueText: value };
    case 'NUMBER':
      if (!/^-?\d{1,15}(\.\d{1,4})?$/.test(String(value))) fail('Use a number with up to 4 decimals');
      return { valueNumber: new Prisma.Decimal(String(value)) };
    case 'DATE':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(Date.parse(value))) fail('Use a date (YYYY-MM-DD)');
      return { valueDate: new Date(`${value}T00:00:00Z`) };
    case 'BOOLEAN':
      if (typeof value !== 'boolean') fail('Use true or false');
      return { valueText: String(value) };
    case 'SELECT':
      if (!options.includes(value)) fail(`Choose one of: ${options.join(', ')}`);
      return { valueText: value };
    case 'MULTI_SELECT':
      if (!Array.isArray(value) || value.some((x) => !options.includes(x))) fail(`Choose from: ${options.join(', ')}`);
      return { valueJson: [...new Set(value)], valueText: [...new Set(value)].join(', ').slice(0, 1000) };
    default:
      return fail('Unknown field type');
  }
}

export function createCustomFieldService({ prisma, clock }) {
  return {
    async definitions(ctx, { entity, includeArchived }) {
      const rows = await prisma.customField.findMany({ where: { organizationId: ctx.orgId, ...(entity ? { entity } : {}), ...(includeArchived ? {} : { archivedAt: null }) }, orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }] });
      return rows.map(serializeField);
    },

    async saveDefinition(ctx, fieldId, body) {
      if (['SELECT', 'MULTI_SELECT'].includes(body.type) && !(body.options ?? []).length) throw new ValidationError([{ path: 'body.options', message: 'Add at least one option' }]);
      try {
        let row;
        if (fieldId) {
          const existing = await prisma.customField.findFirst({ where: { organizationId: ctx.orgId, id: fieldId } });
          if (!existing) throw new NotFoundError('Field not found');
          const { archived, ...rest } = body;
          row = await prisma.customField.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: fieldId } }, data: { ...rest, ...(archived !== undefined ? { archivedAt: archived ? clock.now() : null } : {}) } });
        } else {
          row = await prisma.customField.create({ data: { organizationId: ctx.orgId, ...body } });
        }
        await recordAudit(prisma, ctx, { action: 'customfields.saved', targetType: 'custom_field', targetId: row.id, diff: body });
        return serializeField(row);
      } catch (err) {
        if (err?.code === 'P2002') throw new ConflictError('A field with this key exists for that record type');
        throw err;
      }
    },

    async values(ctx, entity, entityId) {
      await ACCESS[entity](prisma, ctx, entityId, false);
      const fields = await prisma.customField.findMany({ where: { organizationId: ctx.orgId, entity, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
      const values = await prisma.customFieldValue.findMany({ where: { organizationId: ctx.orgId, entityId, fieldId: { in: fields.map((f) => f.id) } } });
      const byField = new Map(values.map((v) => [v.fieldId, v]));
      return fields.map((f) => ({ ...serializeField(f), value: readValue(f, byField.get(f.id)) }));
    },

    /** Whether setValues would be allowed, so clients show an edit control only when it works. */
    async canEdit(ctx, entity, entityId) {
      if (ctx.apiKey) return false;
      try {
        await ACCESS[entity](prisma, ctx, entityId, true);
        return true;
      } catch (err) {
        if (err instanceof ForbiddenError || err instanceof NotFoundError) return false;
        throw err;
      }
    },

    /** Sets values by field key; keys not sent are left unchanged. */
    async setValues(ctx, entity, entityId, values) {
      await ACCESS[entity](prisma, ctx, entityId, true);
      const fields = await prisma.customField.findMany({ where: { organizationId: ctx.orgId, entity, archivedAt: null } });
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const unknown = Object.keys(values).filter((k) => !byKey.has(k));
      if (unknown.length) throw new ValidationError([{ path: 'body.values', message: `Unknown fields: ${unknown.join(', ')}` }]);
      await withTransaction(prisma, async (tx) => {
        for (const [key, value] of Object.entries(values)) {
          const field = byKey.get(key);
          const cols = toColumns(field, value, `body.values.${key}`);
          const where = { organizationId_fieldId_entityId: { organizationId: ctx.orgId, fieldId: field.id, entityId } };
          if (!cols) await tx.customFieldValue.deleteMany({ where: { organizationId: ctx.orgId, fieldId: field.id, entityId } });
          else {
            const data = { valueText: null, valueNumber: null, valueDate: null, valueJson: Prisma.DbNull, ...cols, updatedById: ctx.userId };
            await tx.customFieldValue.upsert({ where, create: { organizationId: ctx.orgId, fieldId: field.id, entityId, ...data }, update: data });
          }
        }
        await recordAudit(tx, ctx, { action: 'customfields.values_set', targetType: entity.toLowerCase(), targetId: entityId, diff: { keys: Object.keys(values) } });
      });
      return this.values(ctx, entity, entityId);
    },
  };
}
