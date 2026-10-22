/**
 * Next number of a per-organization sequence (e.g. invoices). The row is locked for the rest of
 * the caller's transaction, so concurrent issuers queue instead of taking the same number, and a
 * rolled-back transaction leaves no gap. Create the row outside hot transactions if possible:
 * INSERT IGNORE is idempotent and cheap.
 */
export async function nextSequence(tx, organizationId, name) {
  await tx.$executeRaw`INSERT IGNORE INTO document_sequences (organization_id, name, next_value) VALUES (${organizationId}, ${name}, 1)`;
  const [row] = await tx.$queryRaw`SELECT next_value AS value FROM document_sequences WHERE organization_id = ${organizationId} AND name = ${name} FOR UPDATE`;
  await tx.$executeRaw`UPDATE document_sequences SET next_value = next_value + 1 WHERE organization_id = ${organizationId} AND name = ${name}`;
  return Number(row.value);
}

export const formatNumber = (prefix, value, width = 5) => `${prefix}-${String(value).padStart(width, '0')}`;
