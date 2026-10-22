import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueOutbox } from '../../services/outbox.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasPermission, loadEffectivePermissions } from '../rbac/rbac.service.js';
import { SYNC_COMPUTE_BUDGET } from '../activity/stats.js';
import { REPORTS } from './definitions.js';
import { reportCsv, reportPdf } from './render.js';

export const SYNC_MAX_DAYS = 31;
export const JOB_MAX_DAYS = 366;
export const SYNC_MAX_ROWS = 10_000;
export const JOB_TTL_MS = 7 * 86_400_000;
const FORMATS = { csv: { ext: 'csv', mime: 'text/csv' }, pdf: { ext: 'pdf', mime: 'application/pdf' } };

const daysIn = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

function definition(type) {
  const def = REPORTS[type];
  if (!def) throw new NotFoundError('Unknown report');
  return def;
}

function checkParams(def, params, maxDays) {
  if (params.from > params.to) throw new ValidationError([{ path: 'query.to', message: 'to must be on or after from' }]);
  if (daysIn(params.from, params.to) > maxDays) {
    throw new BusinessRuleError(`Ranges longer than ${maxDays} days must be exported as a background report`, 'REPORT_TOO_LARGE');
  }
  const groupBy = params.groupBy ?? def.groupBy[0];
  if (!def.groupBy.includes(groupBy)) throw new ValidationError([{ path: 'query.groupBy', message: `Use one of: ${def.groupBy.join(', ')}` }]);
  return { ...params, groupBy };
}

/** May this caller run (and export) this report? Domain permission, plus reports.export for files. */
function assertAllowed(ctx, def, { exporting = false } = {}) {
  if (!hasPermission(ctx, def.permission)) throw new ForbiddenError('You do not have access to this report');
  if (exporting && !hasPermission(ctx, 'reports.export')) throw new ForbiddenError('You do not have permission to export reports');
}

const serializeJob = (j) => ({
  id: j.id,
  type: j.type,
  title: REPORTS[j.type]?.title ?? j.type,
  format: j.format,
  params: j.params,
  status: j.status,
  rowCount: j.rowCount,
  fileName: j.fileName,
  sizeBytes: j.sizeBytes,
  error: j.error,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
  expiresAt: j.expiresAt,
});

/**
 * Runs a report for a background job as the person who requested it. Their membership and
 * permissions are re-loaded now, so a revoked permission stops a queued export.
 */
export async function runReportJob({ prisma, storage, clock, logger }, { organizationId, jobId }) {
  const job = await prisma.reportJob.findFirst({ where: { organizationId, id: jobId } });
  if (!job || job.status !== 'QUEUED') return { skipped: true };
  const now = clock.now();
  await prisma.reportJob.updateMany({ where: { organizationId, id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: now } });
  try {
    const member = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: job.requestedById } }, include: { organization: true } });
    if (member?.status !== 'ACTIVE') throw new ForbiddenError('The requester is no longer an active member');
    const ctx = { orgId: organizationId, userId: job.requestedById, organization: member.organization, permissions: await loadEffectivePermissions(prisma, organizationId, job.requestedById) };
    const def = definition(job.type);
    assertAllowed(ctx, def, { exporting: true });
    const result = await def.run(prisma, ctx, { ...job.params, budget: Number.MAX_SAFE_INTEGER }, now);
    const format = FORMATS[job.format];
    const body = job.format === 'pdf' ? await reportPdf(result, { organizationName: member.organization.name, generatedAt: now }) : Buffer.from(reportCsv(result), 'utf8');
    const fileName = `${job.type}-${job.params.from}-to-${job.params.to}.${format.ext}`;
    const storageKey = `reports/${organizationId}/${job.id}.${format.ext}`;
    await storage.putObject({ bucket: storage.buckets.files, key: storageKey, body, contentType: format.mime });
    await prisma.reportJob.updateMany({
      where: { organizationId, id: jobId },
      data: { status: 'COMPLETED', rowCount: result.rows.length, storageKey, fileName, sizeBytes: body.length, finishedAt: clock.now(), expiresAt: new Date(clock.now().getTime() + JOB_TTL_MS) },
    });
    return { status: 'COMPLETED' };
  } catch (err) {
    logger?.warn({ jobId, err: err.message }, 'report job failed');
    await prisma.reportJob.updateMany({ where: { organizationId, id: jobId }, data: { status: 'FAILED', error: err.expose ? err.message.slice(0, 500) : 'The report could not be generated', finishedAt: clock.now() } });
    if (err.expose) return { status: 'FAILED' };
    throw err;
  }
}

/** Deletes files of expired exports (hourly). */
export async function expireReportJobs({ prisma, storage, clock }) {
  const expired = await prisma.unscoped.reportJob.findMany({ where: { status: 'COMPLETED', expiresAt: { lt: clock.now() } }, take: 500 });
  for (const job of expired) {
    if (job.storageKey) await storage.remove({ bucket: storage.buckets.files, key: job.storageKey });
    await prisma.reportJob.updateMany({ where: { organizationId: job.organizationId, id: job.id }, data: { status: 'EXPIRED', storageKey: null } });
  }
  return { expired: expired.length };
}

export function createReportService({ prisma, clock, storage }) {
  return {
    /** Reports this caller may run, with their columns' groupings. */
    catalog(ctx) {
      return Object.values(REPORTS)
        .filter((def) => hasPermission(ctx, def.permission))
        .map((def) => ({ type: def.type, title: def.title, description: def.description, groupBy: def.groupBy, canExport: hasPermission(ctx, 'reports.export') }));
    },

    async run(ctx, type, params) {
      const def = definition(type);
      assertAllowed(ctx, def);
      const checked = checkParams(def, params, SYNC_MAX_DAYS);
      const result = await def.run(prisma, ctx, { ...checked, budget: SYNC_COMPUTE_BUDGET }, clock.now());
      if (result.rows.length > SYNC_MAX_ROWS) throw new BusinessRuleError('This report is too large to show; export it instead', 'REPORT_TOO_LARGE');
      return result;
    },

    async createJob(ctx, { type, format, params }) {
      const def = definition(type);
      assertAllowed(ctx, def, { exporting: true });
      const checked = checkParams(def, params, JOB_MAX_DAYS);
      return withTransaction(prisma, async (tx) => {
        const job = await tx.reportJob.create({ data: { organizationId: ctx.orgId, requestedById: ctx.userId, type, format, params: checked, createdAt: clock.now() } });
        await enqueueOutbox(tx, { type: 'report.generate', payload: { organizationId: ctx.orgId, jobId: job.id }, dedupeKey: `report.generate:${job.id}`, organizationId: ctx.orgId });
        await recordAudit(tx, ctx, { action: 'reports.export_requested', targetType: 'report_job', targetId: job.id, diff: { type, format, params: checked } });
        return serializeJob(job);
      });
    },

    async listJobs(ctx) {
      const jobs = await prisma.reportJob.findMany({ where: { organizationId: ctx.orgId, requestedById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
      return jobs.map(serializeJob);
    },

    async getJob(ctx, jobId) {
      const job = await prisma.reportJob.findFirst({ where: { organizationId: ctx.orgId, id: jobId, requestedById: ctx.userId } });
      if (!job) throw new NotFoundError('Export not found');
      return serializeJob(job);
    },

    /** Re-checks permission at download time (FR-RPT-3), then issues a 60-second link. */
    async download(ctx, jobId) {
      const job = await prisma.reportJob.findFirst({ where: { organizationId: ctx.orgId, id: jobId, requestedById: ctx.userId } });
      if (!job) throw new NotFoundError('Export not found');
      assertAllowed(ctx, definition(job.type), { exporting: true });
      if (job.status !== 'COMPLETED' || !job.storageKey || job.expiresAt <= clock.now()) throw new BusinessRuleError(job.status === 'COMPLETED' ? 'This export has expired' : 'This export is not ready');
      await recordAudit(prisma, ctx, { action: 'reports.exported', targetType: 'report_job', targetId: job.id, diff: { type: job.type, format: job.format } });
      return storage.presignGet({ bucket: storage.buckets.files, key: job.storageKey, fileName: job.fileName });
    },
  };
}
