import { Prisma } from '@prisma/client';

const GUARDED_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
]);

/** Models whose rows belong to exactly one organization (they have a required organizationId). */
export const TENANT_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'organizationId' && f.isRequired))
    .map((m) => m.name),
);

// Lookups by a globally unique secret (e.g. a hashed invitation token) identify one row across all
// tenants by design; the row's organization is then taken from the row itself.
const GLOBAL_UNIQUE_LOOKUPS = { Invitation: ['tokenHash'], AgentPairingCode: ['codeHash'] };

function isGlobalUniqueLookup(model, operation, where) {
  return operation.startsWith('findUnique') && (GLOBAL_UNIQUE_LOOKUPS[model] ?? []).some((key) => typeof where?.[key] === 'string');
}

function whereHasTenant(where) {
  if (!where || typeof where !== 'object') return false;
  if (typeof where.organizationId === 'string') return true;
  if (Object.keys(where).some((k) => k.startsWith('organizationId_') && where[k]?.organizationId)) return true;
  if (Array.isArray(where.AND)) return where.AND.some(whereHasTenant);
  return false;
}

function dataHasTenant(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.length > 0 && rows.every((row) => typeof row?.organizationId === 'string' || row?.organization?.connect);
}

/**
 * Development/test safety net: throws when a query on a tenant-owned model is not scoped to an
 * organization. Repositories and services must always pass organizationId (docs/architecture.md §4).
 */
export function tenantGuardExtension() {
  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (TENANT_MODELS.has(model)) {
            const scoped = operation.startsWith('create')
              ? dataHasTenant(args?.data)
              : !GUARDED_OPERATIONS.has(operation) || whereHasTenant(args?.where) || isGlobalUniqueLookup(model, operation, args?.where);
            if (!scoped) {
              throw new Error(`Tenant guard: ${model}.${operation} must be scoped by organizationId`);
            }
          }
          return query(args);
        },
      },
    },
  });
}
