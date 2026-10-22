import { idSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendOk } from '../../utils/response.js';

const clockInBody = z.object({ note: z.string().trim().max(280).optional() }).strict();
const timerBody = z
  .object({
    description: z.string().trim().max(500).optional(),
    isBillable: z.boolean().default(false),
    projectId: idSchema.optional(),
    taskId: idSchema.optional(),
  })
  .strict();

/** Clock, break and timer transitions for the signed-in member. All use server time. */
export function workRoutes({ workService }) {
  const att = ['Attendance'];
  const time = ['Time tracking'];
  return defineRoutes('', (r) => {
    r.get('/attendance/state', { permission: 'attendance.self', tags: att, summary: 'My current work state, open session, timer and today’s totals' }, async (req, res) => {
      sendOk(res, await workService.getState(req.ctx));
    });
    r.post('/attendance/clock-in', { permission: 'attendance.self', body: clockInBody, idempotent: true, tags: att, summary: 'Clock in' }, async (req, res) => {
      sendOk(res, await workService.clockIn(req.ctx, req.valid.body), { status: 201 });
    });
    r.post('/attendance/clock-out', { permission: 'attendance.self', idempotent: true, tags: att, summary: 'Clock out (also stops a running timer)' }, async (req, res) => {
      sendOk(res, await workService.clockOut(req.ctx));
    });
    r.post('/attendance/break/start', { permission: 'attendance.self', tags: att, summary: 'Start a break (pauses a running timer)' }, async (req, res) => {
      sendOk(res, await workService.startBreak(req.ctx));
    });
    r.post('/attendance/break/end', { permission: 'attendance.self', tags: att, summary: 'End the current break' }, async (req, res) => {
      sendOk(res, await workService.endBreak(req.ctx));
    });

    r.get('/time-tracking/active', { permission: 'time.self', tags: time, summary: 'The running or paused timer' }, async (req, res) => {
      sendOk(res, (await workService.getState(req.ctx)).timer);
    });
    r.post('/time-tracking/start', { permission: 'time.self', body: timerBody, idempotent: true, tags: time, summary: 'Start the timer (clocks in if the organization allows)' }, async (req, res) => {
      sendOk(res, await workService.startTimer(req.ctx, req.valid.body), { status: 201 });
    });
    r.post('/time-tracking/pause', { permission: 'time.self', tags: time, summary: 'Pause the timer' }, async (req, res) => {
      sendOk(res, await workService.pauseTimer(req.ctx));
    });
    r.post('/time-tracking/resume', { permission: 'time.self', tags: time, summary: 'Resume the paused timer with the same project/task/description' }, async (req, res) => {
      sendOk(res, await workService.resumeTimer(req.ctx));
    });
    r.post('/time-tracking/stop', { permission: 'time.self', idempotent: true, tags: time, summary: 'Stop the timer' }, async (req, res) => {
      sendOk(res, await workService.stopTimer(req.ctx));
    });
    r.post('/time-tracking/switch', { permission: 'time.self', body: timerBody, tags: time, summary: 'Close the current segment and start a new one with new details' }, async (req, res) => {
      sendOk(res, await workService.switchTimer(req.ctx, req.valid.body));
    });
  });
}
