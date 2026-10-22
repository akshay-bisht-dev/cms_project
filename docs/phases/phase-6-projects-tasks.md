# Phase 6: Projects, tasks and calendar (report)

**Date:** 2026-10-21 · **Status:** complete

## What was built
- **Schema** (migration `…_projects_tasks_calendar`): projects, project members (MANAGER/MEMBER/VIEWER), milestones, per-project workflow statuses, tasks, assignees, checklist items, labels, comments, dependencies, task events, file objects, task attachments, and calendar events with attendees. `time_entries` gained composite FKs to projects and tasks. Project budgets use `DECIMAL(19,4)` and are returned as exact strings.
- **Access:**
  - Project access combines the role grant (org or project scope), the caller's project role, and visibility (PRIVATE or ORG).
  - The RBAC "project" scope now resolves to members of the projects the caller manages, so it applies to time, timesheets, attendance and so on.
  - Assignees can update their own tasks. Viewers are read-only.
- **Projects:** create (generated code, default workflow), edit, archive, restore, close; members; statuses (add, rename, reorder, delete with task move); milestones; a summary of tasks by category, overdue count, hours from real time entries against the estimate, and per-member workload. Budgets are visible only to people allowed to see them.
- **Tasks:**
  - Per-project sequential numbers (`PORTAL-12`), safe under concurrency through a project row lock.
  - One level of subtasks, checklists, labels, comments (assignees notified), and finish-to-start dependencies. Cycles are rejected, and blocked tasks can't start or finish.
  - Recurrence (daily, weekly or monthly; the next occurrence is created on completion), bulk status/priority/assign/archive, and an activity history.
- **Attachments:** presigned direct upload (5 min, size-bound), server verification by HEAD (size and type, mismatches deleted), 60-second download links, type allow-list, and a 25 MB limit.
- **Time tracking integration:** the timer and manual entries accept a project or task. The person must be a non-viewer member, and the task must belong to the project.
- **Calendar:** a read model over holidays, milestones (projects you can see), task deadlines (assigned to you or in projects you manage), and meetings (organizer or attendee, with invitations notified).
- **Jobs:** hourly overdue-task reminders, deduplicated per task per local day.
- **Dashboard:** active projects, overdue tasks in scope, and upcoming deadlines.
- **UI:**
  - Projects list, a Project Management portfolio, and a project page with Overview, Board (drag-and-drop plus a keyboard "Move to"), List (bulk actions), Timeline, Calendar, Milestones, Members and Settings.
  - A task page (inline editing, checklist, subtasks, attachments, comments, dependencies, activity, Track time).
  - My Tasks, a unified Calendar with a meeting scheduler, the project/task picker in the timer and manual entries, and the profile Projects and Tasks tabs.

## Verification (run on 2026-10-21)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit / integration (real MySQL) | **74/74** · **402/402** (149 operations, all in the generated 401/403 suite) |
| Web unit | **13/13** |
| Playwright E2E + axe | **14/14**, including PM board → task page → keyboard move, assignee tracks time and completes, meeting scheduling |
| Visual review | board, timeline, task page, calendar at 1440px |

## Bugs found and fixed
1. **Long notification dedupe keys overflowed `VARCHAR(191)`.** Every task assignment with email enabled failed with a 500. Keys are now digested centrally (`fitKey`), with unit and integration coverage.
2. **A server route imported a constant from a `'use client'` module.** On the server it was only a client reference, so the project page 404'd. Constants moved to plain modules.
3. **Accessibility:** faded "done" calendar items failed contrast.
4. **Layout:** calendar chips overflowed into neighbouring days, the board's last column was clipped, and timeline labels wrapped.
5. **Test isolation:** the projects spec left the employee clocked in.

## Known limitations
- Projects have `client_id` without a foreign key until the CRM (Phase 9). Cost and revenue against budget need billing rates (Phase 9).
- Workflow transitions aren't restricted (any status to any status, subject to dependencies). Per-transition rules are a later extension.
- Task lists return up to 500 items with a `truncated` flag rather than cursor pages.
- Attachments have not been tested against a real S3 or SeaweedFS (no Docker). The signing logic is exercised offline and against a fake store.
- Meetings have no recurrence or external calendar sync. Leave appears on the calendar in Phase 10.
