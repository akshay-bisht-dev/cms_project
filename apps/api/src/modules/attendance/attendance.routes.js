import { idSchema, isoDateSchema, isoDateTimeSchema, timeZoneSchema, z } from '@orbit/validation';
import { MEMBER } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { ForbiddenError } from '../../utils/errors.js';

const rangeQuery = z
  .object({ from: isoDateSchema, to: isoDateSchema, employeeId: idSchema.optional() })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, { message: 'Ranges are limited to one year', path: ['to'] });

const correctionBody = z
  .object({
    kind: z.enum(['ADD', 'MODIFY', 'DELETE']),
    workSessionId: idSchema.optional(),
    proposedStartAt: isoDateTimeSchema.optional(),
    proposedEndAt: isoDateTimeSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((b) => b.kind === 'ADD' || b.workSessionId, { message: 'workSessionId is required', path: ['workSessionId'] })
  .refine((b) => b.kind === 'DELETE' || (b.proposedStartAt && b.proposedEndAt), { message: 'Provide the proposed start and end', path: ['proposedStartAt'] });

const decisionBody = z.object({ comment: z.string().trim().max(500).optional() }).strict();
const rejectBody = z.object({ comment: z.string().trim().min(1, 'Explain why').max(500) }).strict();
const correctionsQuery = z
  .object({ mine: z.enum(['true', 'false']).default('true'), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() })
  .strict();
const idParams = (name) => z.object({ [name]: idSchema }).strict();

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const scheduleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(['FIXED', 'FLEXIBLE']).default('FIXED'),
    timeZone: timeZoneSchema.nullable().default(null),
    days: z
      .array(z.object({ weekday: z.number().int().min(1).max(7), start: clockTime, end: clockTime }).strict())
      .max(7)
      .refine((d) => new Set(d.map((x) => x.weekday)).size === d.length, 'Each weekday may appear once'),
    requiredMinutesPerDay: z.number().int().min(15).max(1440).nullable().default(null),
    isDefault: z.boolean().default(false),
  })
  .strict();
const assignBody = z.object({ targetType: z.enum(['DEPARTMENT', 'TEAM', 'MEMBER']), targetId: idSchema }).strict();
const holidayBody = z.object({ date: isoDateSchema, name: z.string().trim().min(1).max(120), isHalfDay: z.boolean().default(false) }).strict();

export function attendanceRoutes({ attendanceService }) {
  const tags = ['Attendance'];
  return defineRoutes('/attendance', (r) => {
    r.get('/records', { permission: 'attendance.self', query: rangeQuery, tags, summary: 'Daily attendance (mine, or an employee in my scope)' }, async (req, res) => {
      const { items, totals } = await attendanceService.listRecords(req.ctx, req.valid.query);
      sendOk(res, items, { meta: { totals } });
    });
    r.get('/board', { permission: 'attendance.read', tags, summary: 'Live presence of everyone in my scope' }, async (req, res) => {
      sendOk(res, await attendanceService.board(req.ctx));
    });

    r.get('/corrections', { permission: 'attendance.correct.request', query: correctionsQuery, tags, summary: 'My correction requests, or those I can review (mine=false)' }, async (req, res) => {
      if (req.valid.query.mine === 'false' && !req.ctx.permissions.has('attendance.correct.approve')) throw new ForbiddenError();
      sendOk(res, await attendanceService.listCorrections(req.ctx, req.valid.query));
    });
    r.post('/corrections', { permission: 'attendance.correct.request', body: correctionBody, idempotent: true, tags, summary: 'Request a correction to my attendance' }, async (req, res) => {
      sendCreated(res, await attendanceService.requestCorrection(req.ctx, req.valid.body));
    });
    r.post('/corrections/:correctionId/approve', { permission: 'attendance.correct.approve', params: idParams('correctionId'), body: decisionBody, tags, summary: 'Approve and apply a correction' }, async (req, res) => {
      sendOk(res, await attendanceService.decideCorrection(req.ctx, req.valid.params.correctionId, { decision: 'APPROVED', ...req.valid.body }));
    });
    r.post('/corrections/:correctionId/reject', { permission: 'attendance.correct.approve', params: idParams('correctionId'), body: rejectBody, tags, summary: 'Reject a correction' }, async (req, res) => {
      sendOk(res, await attendanceService.decideCorrection(req.ctx, req.valid.params.correctionId, { decision: 'REJECTED', ...req.valid.body }));
    });
    r.post('/corrections/:correctionId/cancel', { permission: 'attendance.correct.request', params: idParams('correctionId'), tags, summary: 'Cancel my pending correction' }, async (req, res) => {
      await attendanceService.cancelCorrection(req.ctx, req.valid.params.correctionId);
      sendNoContent(res);
    });

    r.get('/schedules', { permission: MEMBER, tags, summary: 'Work schedules' }, async (req, res) => {
      sendOk(res, await attendanceService.listSchedules(req.ctx));
    });
    r.post('/schedules', { permission: 'org.settings.manage', body: scheduleBody, tags, summary: 'Create a work schedule' }, async (req, res) => {
      sendCreated(res, await attendanceService.saveSchedule(req.ctx, null, req.valid.body));
    });
    r.put('/schedules/:scheduleId', { permission: 'org.settings.manage', params: idParams('scheduleId'), body: scheduleBody, tags, summary: 'Replace a work schedule' }, async (req, res) => {
      sendOk(res, await attendanceService.saveSchedule(req.ctx, req.valid.params.scheduleId, req.valid.body));
    });
    r.delete('/schedules/:scheduleId', { permission: 'org.settings.manage', params: idParams('scheduleId'), tags, summary: 'Archive a work schedule' }, async (req, res) => {
      await attendanceService.archiveSchedule(req.ctx, req.valid.params.scheduleId);
      sendNoContent(res);
    });
    r.post('/schedules/:scheduleId/assignments', { permission: 'org.settings.manage', params: idParams('scheduleId'), body: assignBody, tags, summary: 'Assign a schedule to a department, team or employee' }, async (req, res) => {
      sendOk(res, await attendanceService.assignSchedule(req.ctx, req.valid.params.scheduleId, req.valid.body));
    });

    r.get('/holidays', { permission: MEMBER, query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }).strict(), tags, summary: 'Holidays for a year' }, async (req, res) => {
      sendOk(res, await attendanceService.listHolidays(req.ctx, req.valid.query));
    });
    r.post('/holidays', { permission: 'org.settings.manage', body: holidayBody, tags, summary: 'Add a holiday' }, async (req, res) => {
      sendCreated(res, await attendanceService.createHoliday(req.ctx, req.valid.body));
    });
    r.delete('/holidays/:holidayId', { permission: 'org.settings.manage', params: idParams('holidayId'), tags, summary: 'Remove a holiday' }, async (req, res) => {
      await attendanceService.deleteHoliday(req.ctx, req.valid.params.holidayId);
      sendNoContent(res);
    });
  });
}
