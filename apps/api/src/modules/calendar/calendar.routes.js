import { idSchema, isoDateSchema, isoDateTimeSchema, z } from '@orbit/validation';
import { MEMBER } from '../../middleware/authorize.js';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';

const rangeQuery = z
  .object({ from: isoDateSchema, to: isoDateSchema, sources: z.string().regex(/^[a-z,]+$/).optional() })
  .strict()
  .refine((q) => q.from <= q.to, { path: ['to'], message: 'from must be on or before to' });
const meetingBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional(),
    startAt: isoDateTimeSchema,
    endAt: isoDateTimeSchema,
    allDay: z.boolean().default(false),
    location: z.string().trim().max(200).optional(),
    projectId: idSchema.optional(),
    attendeeEmployeeIds: z.array(idSchema).max(100).default([]),
  })
  .strict();

export function calendarRoutes({ calendarService }) {
  const tags = ['Calendar'];
  return defineRoutes('/calendar', (r) => {
    r.get('/', { permission: MEMBER, query: rangeQuery, tags, summary: 'Unified calendar: holidays, milestones, task deadlines, meetings' }, async (req, res) => {
      sendOk(res, await calendarService.range(req.ctx, req.valid.query));
    });
    r.post('/events', { permission: MEMBER, body: meetingBody, tags, summary: 'Schedule a meeting (invites attendees)' }, async (req, res) => {
      sendCreated(res, await calendarService.createMeeting(req.ctx, req.valid.body));
    });
    r.get('/events/:eventId', { permission: MEMBER, params: z.object({ eventId: idSchema }).strict(), tags, summary: 'A meeting I organize or attend' }, async (req, res) => {
      sendOk(res, await calendarService.getMeeting(req.ctx, req.valid.params.eventId));
    });
    r.delete('/events/:eventId', { permission: MEMBER, params: z.object({ eventId: idSchema }).strict(), tags, summary: 'Cancel a meeting I organize' }, async (req, res) => {
      await calendarService.cancelMeeting(req.ctx, req.valid.params.eventId);
      sendNoContent(res);
    });
  });
}
