import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { notifyOverdueTasks } from '../../src/modules/tasks/tasks.service.js';
import { createFieldCipher } from '../../src/services/crypto.js';

const { app, prisma, clock, env, storage } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T06:00:00Z');
  await resetDatabase(prisma);
});
void pino;

let n = 0;
const key = () => ({ 'Idempotency-Key': `prj-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  await prisma.organization.update({ where: { id: ctx.org.id }, data: { timeZone: 'UTC' } });
  const pm = await createMember(prisma, ctx, { role: 'PROJECT_MANAGER', name: 'Pam PM' });
  const dev = await createMember(prisma, ctx, { name: 'Dev' });
  const viewer = await createMember(prisma, ctx, { name: 'Vi' });
  const outsider = await createMember(prisma, ctx, { name: 'Out' });
  const pmClient = await login(app, pm.user.email);
  const project = (
    await pmClient.post('/projects', { name: 'Customer Portal', status: 'ACTIVE', estimatedS: 100 * 3600, memberEmployeeIds: [dev.employeeId] })
  ).body.data;
  await pmClient.put(`/projects/${project.id}/members`, {
    members: [
      { employeeId: dev.employeeId, role: 'MEMBER' },
      { employeeId: viewer.employeeId, role: 'VIEWER' },
    ],
  });
  return { ...ctx, pm, dev, viewer, outsider, pmClient, project, devClient: await login(app, dev.user.email) };
}

const createTask = (client, projectId, body = {}) => client.post('/tasks', { projectId, title: 'Task', ...body }, key());

describe('projects', () => {
  it('creates a project with a generated code, default workflow and the creator as manager', async () => {
    const s = await setup();
    expect(s.project).toMatchObject({ code: 'CP', status: 'ACTIVE', manager: { name: 'Pam PM' }, access: { role: 'MANAGER', canManage: true } });
    const statuses = (await s.pmClient.get(`/projects/${s.project.id}/statuses`)).body.data;
    expect(statuses.map((x) => [x.name, x.category])).toEqual([
      ['To do', 'TODO'],
      ['In progress', 'IN_PROGRESS'],
      ['In review', 'IN_PROGRESS'],
      ['Done', 'DONE'],
    ]);
    expect((await s.devClient.post('/projects', { name: 'Mine' })).status).toBe(403);
    expect((await s.pmClient.post('/projects', { name: 'Customer Portal 2', code: 'CP' })).status).toBe(409);
  });

  it('hides private projects from non-members and shows org-visible ones', async () => {
    const s = await setup();
    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.get('/projects')).body.data).toHaveLength(0);
    expect((await outsider.get(`/projects/${s.project.id}`)).status).toBe(404);
    await s.pmClient.patch(`/projects/${s.project.id}`, { visibility: 'ORG' });
    expect((await outsider.get('/projects')).body.data.map((p) => p.code)).toEqual(['CP']);
    expect((await outsider.patch(`/projects/${s.project.id}`, { name: 'x' })).status).toBe(403);
  });

  it('shows the budget only to people allowed to see it, as an exact decimal string', async () => {
    const s = await setup();
    await s.pmClient.patch(`/projects/${s.project.id}`, { budget: { amount: '12500.50', currency: 'USD' } });
    expect((await s.pmClient.get(`/projects/${s.project.id}`)).body.data.budget).toEqual({ amount: '12500.50', currency: 'USD' });
    expect((await s.devClient.get(`/projects/${s.project.id}`)).body.data.budget).toBeUndefined();
  });

  it('archives and restores, blocking task creation while archived', async () => {
    const s = await setup();
    await s.pmClient.delete(`/projects/${s.project.id}`);
    expect((await s.pmClient.get('/projects')).body.data).toHaveLength(0);
    expect((await createTask(s.pmClient, s.project.id)).status).toBe(422);
    await s.pmClient.post(`/projects/${s.project.id}/restore`);
    expect((await createTask(s.pmClient, s.project.id)).status).toBe(201);
  });
});

describe('tasks', () => {
  it('numbers tasks sequentially per project, even when created concurrently', async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createTask(s.pmClient, s.project.id, { title: `T${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.map((r) => r.body.data.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results[0].body.data.key).toMatch(/^CP-\d+$/);
  });

  it('lets assignees update their own task but not create; non-members cannot see it', async () => {
    const s = await setup();
    // Employees hold tasks.update (project) but not tasks.create.
    expect((await createTask(s.devClient, s.project.id)).status).toBe(403);
    const task = (await createTask(s.pmClient, s.project.id, { assigneeEmployeeIds: [s.dev.employeeId], dueDate: '2026-10-25' })).body.data;
    expect(task.assignees.map((a) => a.name)).toEqual(['Dev']);
    expect((await s.devClient.get('/notifications')).body.data[0].type).toBe('tasks.assigned');

    const statuses = (await s.devClient.get(`/projects/${s.project.id}/statuses`)).body.data;
    const done = statuses.find((x) => x.category === 'DONE');
    const updated = await s.devClient.patch(`/tasks/${task.id}`, { statusId: done.id });
    expect(updated.body.data).toMatchObject({ status: { category: 'DONE' } });
    expect(updated.body.data.completedAt).not.toBeNull();

    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await outsider.get('/tasks?assignee=me')).body.data).toHaveLength(0);
    expect((await s.devClient.get('/tasks?assignee=me')).body.data.map((t) => t.id)).toEqual([task.id]);
  });

  it('only assigns project members who are not viewers', async () => {
    const s = await setup();
    expect((await createTask(s.pmClient, s.project.id, { assigneeEmployeeIds: [s.viewer.employeeId] })).status).toBe(400);
    expect((await createTask(s.pmClient, s.project.id, { assigneeEmployeeIds: [s.outsider.employeeId] })).status).toBe(400);
    const viewer = await login(app, s.viewer.user.email);
    const task = (await createTask(s.pmClient, s.project.id)).body.data;
    expect((await viewer.get(`/tasks/${task.id}`)).status).toBe(200);
    expect((await viewer.patch(`/tasks/${task.id}`, { title: 'x' })).status).toBe(403);
  });

  it('enforces dependencies: no cycles, and blocked tasks cannot start until blockers finish', async () => {
    const s = await setup();
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(async (title) => (await createTask(s.pmClient, s.project.id, { title })).body.data));
    await s.pmClient.post(`/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id });
    await s.pmClient.post(`/tasks/${c.id}/dependencies`, { dependsOnTaskId: b.id });
    const cycle = await s.pmClient.post(`/tasks/${a.id}/dependencies`, { dependsOnTaskId: c.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.details[0].message).toMatch(/cycle/);

    const statuses = (await s.pmClient.get(`/projects/${s.project.id}/statuses`)).body.data;
    const inProgress = statuses.find((x) => x.category === 'IN_PROGRESS');
    const done = statuses.find((x) => x.category === 'DONE');
    const blocked = await s.pmClient.patch(`/tasks/${b.id}`, { statusId: inProgress.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TASK_BLOCKED');
    await s.pmClient.patch(`/tasks/${a.id}`, { statusId: done.id });
    expect((await s.pmClient.patch(`/tasks/${b.id}`, { statusId: inProgress.id })).status).toBe(200);
    const detail = (await s.pmClient.get(`/tasks/${b.id}`)).body.data;
    expect(detail.dependsOn.map((d) => d.title)).toEqual(['A']);
    expect(detail.blocks.map((d) => d.title)).toEqual(['C']);
  });

  it('supports one level of subtasks, checklists, labels and comments that notify assignees', async () => {
    const s = await setup();
    const parent = (await createTask(s.pmClient, s.project.id, { title: 'Epic', assigneeEmployeeIds: [s.dev.employeeId] })).body.data;
    const child = (await createTask(s.pmClient, s.project.id, { title: 'Child', parentId: parent.id })).body.data;
    expect((await createTask(s.pmClient, s.project.id, { title: 'Grandchild', parentId: child.id })).status).toBe(400);

    await s.pmClient.post(`/tasks/${parent.id}/checklist`, { text: 'Write tests' });
    const withItem = (await s.pmClient.get(`/tasks/${parent.id}`)).body.data;
    await s.devClient.patch(`/tasks/${parent.id}/checklist/${withItem.checklist[0].id}`, { done: true });
    const label = (await s.pmClient.post('/labels', { name: 'backend', color: '#126B32' })).body.data;
    await s.pmClient.put(`/tasks/${parent.id}/labels`, { labelIds: [label.id] });
    await s.pmClient.post(`/tasks/${parent.id}/comments`, { body: 'Please start with the API' });

    const detail = (await s.devClient.get(`/tasks/${parent.id}`)).body.data;
    expect(detail.subtasks.map((x) => x.title)).toEqual(['Child']);
    expect(detail.checklist).toEqual([expect.objectContaining({ text: 'Write tests', done: true })]);
    expect(detail.labels.map((l) => l.name)).toEqual(['backend']);
    expect(detail.comments[0]).toMatchObject({ body: 'Please start with the API', author: { name: 'Pam PM' }, mine: false });
    expect(detail.history.map((h) => h.type)).toEqual(expect.arrayContaining(['created', 'commented']));
    const notes = (await s.devClient.get('/notifications')).body.data.map((x) => x.type);
    expect(notes).toEqual(expect.arrayContaining(['tasks.commented', 'tasks.assigned']));

    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.post(`/tasks/${parent.id}/comments`, { body: 'hi' })).status).toBe(404);
  });

  it('creates the next occurrence when a recurring task is completed', async () => {
    const s = await setup();
    const task = (await createTask(s.pmClient, s.project.id, { title: 'Weekly report', dueDate: '2026-10-23', recurrence: { frequency: 'WEEKLY', interval: 1 }, assigneeEmployeeIds: [s.dev.employeeId] })).body.data;
    const done = (await s.pmClient.get(`/projects/${s.project.id}/statuses`)).body.data.find((x) => x.category === 'DONE');
    await s.pmClient.patch(`/tasks/${task.id}`, { statusId: done.id });
    const all = (await s.pmClient.get(`/tasks?projectId=${s.project.id}`)).body.data;
    const next = all.find((t) => t.id !== task.id);
    expect(next).toMatchObject({ title: 'Weekly report', dueDate: '2026-10-30', status: { category: 'TODO' } });
    expect(next.assignees.map((a) => a.name)).toEqual(['Dev']);
  });

  it('applies bulk changes atomically within one project', async () => {
    const s = await setup();
    const ids = await Promise.all([1, 2, 3].map(async (i) => (await createTask(s.pmClient, s.project.id, { title: `B${i}` })).body.data.id));
    expect((await s.pmClient.post('/tasks/bulk', { taskIds: ids, action: 'priority', value: 'URGENT' })).body.data.updated).toBe(3);
    expect((await s.pmClient.get(`/tasks?projectId=${s.project.id}`)).body.data.every((t) => t.priority === 'URGENT')).toBe(true);
    await s.pmClient.post('/tasks/bulk', { taskIds: ids.slice(0, 2), action: 'archive' });
    expect((await s.pmClient.get(`/tasks?projectId=${s.project.id}`)).body.data).toHaveLength(1);
  });
});

describe('attachments', () => {
  it('uploads through a signed URL, verifies the object, and gives short-lived download links', async () => {
    const s = await setup();
    const task = (await createTask(s.pmClient, s.project.id)).body.data;
    const presign = await s.pmClient.post(`/tasks/${task.id}/attachments/presign`, { fileName: 'spec.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
    expect(presign.status).toBe(201);
    const fileKey = new URL(presign.body.data.upload.url).pathname.slice(1);

    expect((await s.pmClient.post(`/tasks/${task.id}/attachments/${presign.body.data.fileId}/complete`)).status).toBe(422); // not uploaded yet
    storage.objects.set(fileKey, { contentLength: 2048, contentType: 'application/pdf' });
    const done = await s.pmClient.post(`/tasks/${task.id}/attachments/${presign.body.data.fileId}/complete`);
    expect(done.body.data.attachments).toEqual([expect.objectContaining({ name: 'spec.pdf', sizeBytes: 2048, status: 'READY' })]);

    const link = await s.devClient.get(`/tasks/${task.id}/attachments/${presign.body.data.fileId}/access-url`);
    expect(link.body.data.url).toContain('spec.pdf');
    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.get(`/tasks/${task.id}/attachments/${presign.body.data.fileId}/access-url`)).status).toBe(404);
  });

  it('rejects disallowed types, oversized files, and uploads that do not match the declaration', async () => {
    const s = await setup();
    const task = (await createTask(s.pmClient, s.project.id)).body.data;
    expect((await s.pmClient.post(`/tasks/${task.id}/attachments/presign`, { fileName: 'x.html', contentType: 'text/html', sizeBytes: 10 })).status).toBe(400);
    expect((await s.pmClient.post(`/tasks/${task.id}/attachments/presign`, { fileName: 'x.zip', contentType: 'application/zip', sizeBytes: 26 * 1024 * 1024 })).status).toBe(400);
    const p = (await s.pmClient.post(`/tasks/${task.id}/attachments/presign`, { fileName: 'a.png', contentType: 'image/png', sizeBytes: 100 })).body.data;
    const objectKey = new URL(p.upload.url).pathname.slice(1);
    storage.objects.set(objectKey, { contentLength: 999_999, contentType: 'image/png' });
    expect((await s.pmClient.post(`/tasks/${task.id}/attachments/${p.fileId}/complete`)).status).toBe(422);
    expect(storage.objects.has(objectKey)).toBe(false); // the mismatched object is deleted
  });
});

describe('time on projects', () => {
  it('tracks time on project tasks for members only, and the summary uses those entries', async () => {
    const s = await setup();
    const task = (await createTask(s.pmClient, s.project.id, { assigneeEmployeeIds: [s.dev.employeeId], estimatedS: 7200, dueDate: '2026-10-20' })).body.data;
    const started = await s.devClient.post('/time-tracking/start', { description: 'Build', taskId: task.id, isBillable: true }, key());
    expect(started.status).toBe(201);
    clock.advance(90 * 60_000);
    await s.devClient.post('/time-tracking/stop', undefined, key());

    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.post('/time-tracking/start', { taskId: task.id }, key())).status).toBe(403);
    const other = (await s.pmClient.post('/projects', { name: 'Other' })).body.data;
    expect((await s.devClient.post('/time-tracking/start', { projectId: other.id, taskId: task.id }, key())).status).toBe(400);

    const [entry] = (await s.devClient.get('/time-entries?from=2026-10-21&to=2026-10-21')).body.data;
    expect(entry).toMatchObject({ project: { code: 'CP' }, task: { key: `CP-${task.number}` }, durationS: 5400 });
    expect((await s.devClient.get(`/tasks/${task.id}`)).body.data.trackedS).toBe(5400);

    const summary = (await s.pmClient.get(`/projects/${s.project.id}/summary`)).body.data;
    expect(summary.hours).toMatchObject({ actualS: 5400, billableS: 5400, estimatedS: 360000, taskEstimateS: 7200, utilization: 1.5 });
    expect(summary.tasks).toMatchObject({ total: 1, overdue: 1 });
    expect(summary.workload.find((w) => w.name === 'Dev')).toMatchObject({ openTasks: 1, trackedS: 5400 });
  });

  it('gives project managers project-scoped access to their members’ time', async () => {
    const s = await setup();
    await s.devClient.post('/time-entries', { startedAt: '2026-10-20T09:00:00Z', endedAt: '2026-10-20T10:00:00Z', projectId: s.project.id }, key());
    expect((await s.pmClient.get(`/time-entries?from=2026-10-20&to=2026-10-20&employeeId=${s.dev.employeeId}`)).body.data).toHaveLength(1);
    expect((await s.pmClient.get(`/time-entries?from=2026-10-20&to=2026-10-20&employeeId=${s.outsider.employeeId}`)).status).toBe(403);
  });
});

describe('calendar and reminders', () => {
  it('merges holidays, milestones, my task deadlines and my meetings', async () => {
    const s = await setup();
    await prisma.holiday.create({ data: { organizationId: s.org.id, date: new Date('2026-10-26T00:00:00Z'), name: 'Festival' } });
    await s.pmClient.post(`/projects/${s.project.id}/milestones`, { name: 'Beta', dueDate: '2026-10-28' });
    await createTask(s.pmClient, s.project.id, { title: 'Ship', dueDate: '2026-10-27', assigneeEmployeeIds: [s.dev.employeeId] });
    const meeting = await s.pmClient.post('/calendar/events', {
      title: 'Planning',
      startAt: '2026-10-22T10:00:00Z',
      endAt: '2026-10-22T11:00:00Z',
      attendeeEmployeeIds: [s.dev.employeeId],
    });
    expect(meeting.body.data.attendees.map((a) => a.name).sort()).toEqual(['Dev', 'Pam PM']);

    const cal = (await s.devClient.get('/calendar?from=2026-10-20&to=2026-10-31')).body.data;
    expect(cal.map((e) => [e.source, e.title])).toEqual([
      ['meetings', 'Planning'],
      ['holidays', 'Festival'],
      ['tasks', expect.stringMatching(/^CP-\d+ Ship$/)],
      ['milestones', 'CP: Beta'],
    ]);
    const outsider = await login(app, s.outsider.user.email);
    const theirs = (await outsider.get('/calendar?from=2026-10-20&to=2026-10-31')).body.data;
    expect(theirs.map((e) => e.source)).toEqual(['holidays']);
    expect((await s.devClient.delete(`/calendar/events/${meeting.body.data.id}`)).status).toBe(403);
    expect((await s.devClient.get('/calendar?from=2026-01-01&to=2026-12-31')).status).toBe(400);
  });

  it('reminds assignees of overdue tasks once per day', async () => {
    const s = await setup();
    await createTask(s.pmClient, s.project.id, { title: 'Late', dueDate: '2026-10-20', assigneeEmployeeIds: [s.dev.employeeId] });
    await createTask(s.pmClient, s.project.id, { title: 'On time', dueDate: '2026-10-30', assigneeEmployeeIds: [s.dev.employeeId] });
    expect((await notifyOverdueTasks({ prisma, clock, cipher, env })).notified).toBe(1);
    expect((await notifyOverdueTasks({ prisma, clock, cipher, env })).notified).toBe(0);
    clock.advance(86_400_000);
    expect((await notifyOverdueTasks({ prisma, clock, cipher, env })).notified).toBe(1);
  });
});

describe('tenant isolation for projects and tasks', () => {
  it('answers 404 to another organization’s owner', async () => {
    const s = await setup();
    const task = (await createTask(s.pmClient, s.project.id)).body.data;
    const other = await createOrg(prisma);
    const intruder = await login(app, other.owner.email);
    expect((await intruder.get(`/projects/${s.project.id}`)).status).toBe(404);
    expect((await intruder.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await intruder.patch(`/tasks/${task.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await intruder.post('/tasks', { projectId: s.project.id, title: 'x' }, key())).status).toBe(404);
    expect((await intruder.get(`/tasks?projectId=${s.project.id}`)).status).toBe(404);
  });
});

describe('dashboard project metrics', () => {
  it('counts active projects, overdue tasks and upcoming deadlines within scope', async () => {
    const s = await setup();
    await createTask(s.pmClient, s.project.id, { title: 'Late', dueDate: '2026-10-19', assigneeEmployeeIds: [s.dev.employeeId] });
    await createTask(s.pmClient, s.project.id, { title: 'Soon', dueDate: '2026-10-24', assigneeEmployeeIds: [s.dev.employeeId] });
    const summary = (await s.pmClient.get('/dashboard/summary')).body.data;
    expect(summary.projects).toEqual({ active: 1, overdueTasks: 1 });
    expect(summary.upcomingDeadlines.map((d) => d.title)).toEqual(['Soon']);
    const outsider = await login(app, s.outsider.user.email);
    expect((await outsider.get('/dashboard/summary')).body.data.projects).toEqual({ active: 0, overdueTasks: 0 });
    expect((await s.pmClient.get(`/projects?memberEmployeeId=${s.dev.employeeId}`)).body.data.map((p) => p.code)).toEqual(['CP']);
  });
});
