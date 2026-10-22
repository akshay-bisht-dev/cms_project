# Frontend Route & Component Map

Next.js App Router, JSX only. Business data comes from the Express API through
`packages/api-client` + TanStack Query. Next.js route handlers contain no business logic.

## 1. Rendering & data strategy

- **Layouts are server components.** `(dashboard)/layout.jsx` calls `GET /api/v1/auth/me` server-side (forwarding the cookie to `API_INTERNAL_URL`). It redirects to `/login` on 401 and passes `me` (permissions, org, branding) to a client `SessionProvider`.
- **Pages are thin.** They read `searchParams` and render a client feature component that queries with TanStack Query. URL query params are the source of truth for filters, sort, and pagination, so views can be shared and reloaded.
- **Zustand only for cross-cutting client state:** sidebar collapsed, active-timer UI mirror (the server stays authoritative), command palette, socket connection status.
- **Socket.IO client** in a `RealtimeProvider`. Incoming events only call `queryClient.invalidateQueries(...)`.
- **Permission gating:** the `<Can permission="timesheets.approve" scope="team">` component and the `useCan()` hook read `me.permissions`. Nav items, tabs, and buttons are hidden or disabled with it. The server enforces regardless.
- **Middleware** (`middleware.js`) does only a cheap cookie-presence redirect and sets security headers (CSP nonce). It makes no auth decision.

## 2. Route map

| Route | Page | Main permission |
|---|---|---|
| **(auth)** | | |
| `/login` | Email/password, org picker step, MFA step | public |
| `/forgot-password`, `/reset-password?token=` | Reset flow | public |
| `/verify-email?token=`, `/accept-invite?token=` | Token flows, set password | public |
| `/register` | Create organization | public |
| **(dashboard)** — sidebar layout | | |
| `/my-dashboard` | Personal: timer, today's sessions, tasks due, leave balance, monitoring status | any member |
| `/dashboard` | Org/team widgets (presence, hours, billable, projects, overdue, pending approvals, trends) | `dashboard.read` |
| `/project-management` | Portfolio: health, workload heatmap, budget vs actual | `projects.read` |
| `/timesheets`, `/timesheets/[id]`, `/timesheets/approvals` | My timesheets, detail, approval queue | `timesheets.*` |
| `/time` | Timer + time entries (day/week), manual entry | `time.self` |
| `/activity` | Timelines (me / team / org) | `attendance.read` / self |
| `/insights` | Distribution, coverage, billable split, task analytics | `reports.*` |
| `/reports`, `/reports/[reportKey]`, `/reports/jobs` | Catalog, report viewer, export jobs | `reports.*` |
| `/calendar` | Unified calendar (month/week/agenda) | any |
| `/projects`, `/projects/new`, `/projects/[projectId]/[[...tab]]` | List/kanban, detail tabs: overview, tasks, board, timeline, calendar, members, budget, files, activity, settings | `projects.read` |
| `/tasks`, `/tasks/[taskId]` | My/all tasks, task drawer page | `tasks.read` |
| `/clients`, `/clients/[clientId]/[[...tab]]` | Clients; tabs: overview, contacts, projects, tickets, invoices, notes, documents | `clients.read` |
| `/leads`, `/opportunities` | Lead list + pipeline kanban | `leads.manage` / `opportunities.manage` |
| `/tickets`, `/tickets/[ticketId]` | Support desk | `tickets.read` |
| `/employees`, `/employees/[employeeId]/[[...tab]]` | Directory; profile tabs (dashboard, attendance, time-off, profile, app-settings, integrations, activity, projects, tasks, timesheets, screenshots, documents) | `employees.read` |
| `/departments`, `/teams` | Structure management | `departments.manage` / `teams.manage` |
| `/attendance`, `/attendance/corrections` | Attendance board & corrections | `attendance.read` |
| `/screenshots` | Gallery (manager view) | `monitoring.screenshots.read` |
| `/monitoring` | **Employee-facing** status: active policy, interval, notice, consent, my agents, my captures | `monitoring.self` |
| `/leave`, `/leave/requests`, `/leave/calendar`, `/leave/approvals` | Time off | `leave.*` |
| `/financials/{invoices,invoices/[id],expenses,quotes,rates,payments,profitability}` | Finance | `finance.*` |
| `/documents` | Org/HR/project documents I can access | module perms |
| `/notifications` | History + preferences | self |
| `/settings/{organization,branding,departments,teams,roles,schedules,attendance,time-tracking,monitoring,retention,leave,holidays,custom-fields,notifications,email,security,sessions,api-keys,webhooks,integrations,storage,subscription,usage,data}` | Admin | per section |
| `/audit-logs` | Audit viewer | `audit.read` |
| `/account/{profile,security,sessions,notifications}` | Self-service | self |
| **(portal)** — client-user layout | | |
| `/portal`, `/portal/projects/[id]`, `/portal/tickets`, `/portal/invoices`, `/portal/documents` | Client portal | `tickets.client` etc. |
| **(platform)** — super admin layout | | |
| `/platform/orgs`, `/platform/health`, `/platform/support-grants` | Platform | platform admin |

Each route group has its own `loading.jsx` (skeleton), `error.jsx` (retry + request ID), and `not-found.jsx`.

## 3. Sidebar

```
WORK
  My Dashboard · Dashboard · Project Management · Timesheets · Activity · Insights · Reports · Calendar
DELIVERY
  Projects · Tasks · Clients / CRM ▸ (Clients, Leads, Opportunities, Quotes) · Support Tickets
PEOPLE
  People ▸ (Directory, Departments, Teams) · Attendance · Time Off · Screenshots · Financials ▸ (…)
  Documents
ADMIN
  Notifications · Settings · Custom Fields · Integrations · Audit Logs
```
Groups are collapsible. A collapsed rail shows icons with tooltips. Items the user has no
permission for are removed (not just disabled). On mobile (< 1024px) the sidebar is a
`Sheet` drawer. The active state is computed from the pathname prefix.

## 4. Component hierarchy

```
app/(dashboard)/layout.jsx            (server: fetch me)
└─ AppProviders                       QueryClientProvider, SessionProvider, RealtimeProvider, ThemeProvider, Toaster
   └─ AppShell
      ├─ Sidebar ─ SidebarGroup ─ SidebarItem (Tooltip)
      ├─ Topbar ─ OrgSwitcher · GlobalSearch(CommandDialog) · TimerWidget · NotificationBell · UserMenu
      └─ <main> page
          ├─ PageHeader (title, breadcrumbs, actions)
          └─ Feature component, e.g.:

EmployeeProfilePage
├─ ProfileHeader ─ Avatar · NameBlock · StatusBadge · MetaChips (ID, dept, designation) · ProfileActions
├─ ProfileTabs (permission-filtered, URL-driven)
└─ Tab panels
   ├─ ProfileOverviewTab ─ InfoCard×N (Basic, Work, Contact, Employment, Schedule) ─ FieldGrid · EditDialog(RHF+Zod)
   ├─ AttendanceTab ─ DateRangeFilter · AttendanceCalendar · SessionTable · CorrectionDialog
   ├─ TimesheetsTab ─ TimesheetTable · TimesheetStatusBadge
   ├─ ScreenshotsTab ─ ScreenshotTimeline ─ ScreenshotTile ─ ScreenshotViewer(Dialog)
   └─ …

DataTable (shared, TanStack Table)
├─ DataTableToolbar ─ SearchInput(debounced) · FacetFilter · DateRangePicker · ColumnToggle · ExportButton
├─ Table (shadcn) with sortable headers, row selection, bulk-action bar
├─ DataTableSkeleton · EmptyState · ErrorState(retry, requestId)
└─ CursorPagination | OffsetPagination

Dashboard
├─ DashboardFilters (date range, department, team, project) → URL params
├─ StatGrid ─ StatCard (value, delta, "measured/derived" hint, link to drill-down)
├─ PresenceCard (working / break / not working / absent / leave, realtime)
├─ HoursTrendChart · BillableSplitChart · AttendanceTrendChart · WorkloadChart (Recharts, ResponsiveContainer)
└─ RecentActivityList · UpcomingDeadlinesList · PendingApprovalsList
```

Shared primitives (shadcn JSX, `components/ui`): Button, Input, Select, Combobox, Dialog,
AlertDialog (confirmations), Sheet, Tabs, Badge, Card, Table, Tooltip, DropdownMenu,
Calendar, Popover, Skeleton, Sonner toasts, Form (RHF integration).

## 5. Design tokens

| Token | Value | Use |
|---|---|---|
| `--sidebar` | `#2A1B4E` (deep violet) | Sidebar bg |
| `--sidebar-foreground` | `#E9E4F5` | Sidebar text (contrast ≈12.4:1) |
| `--sidebar-active` | `#4B3584` | Active pill |
| `--primary` | `#6D4AE0` | Buttons, links (white text ≈5.7:1) |
| `--primary-hover` | `#5A39C9` | |
| `--background` | `#F7F7FA` | Page |
| `--card` | `#FFFFFF`, border `#E6E4EE`, radius 12px | Cards |
| `--success / warning / danger / info` | `#126B32 / #9A4508 / #C62828 / #1D4ED8` | Status (each badge also has text + icon). Darkened in Phase 4 so text stays ≥ 5.5:1 on its own 10% tint (axe-verified). |
| Typography | Inter (variable), 14px base, 1.5 line-height. Headings 600. | |
| Spacing | 4px scale. Page padding 24 (16 on mobile). Card padding 20. | |

Dark mode tokens are defined in Phase 4 but not required for v1 acceptance.

## 6. Implementation notes (Phase 4)

- **Tables:** a small server-driven `DataTable` (`components/data-tables`). Sorting, filtering and cursor pagination happen in the API, so a client-side table engine isn't needed.
- **Selects:** native `<select>` styled with tokens. It's accessible and mobile-friendly with no extra dependency.
- **Toasts:** Sonner in its neutral style. Its "rich colors" mode failed the 4.5:1 contrast check.
- **Unbuilt modules** show as disabled nav items and profile tabs, with screen-reader text saying which phase builds them. They never link to empty or invented pages.
- **Real-time:** in development the browser connects to the API origin (`NEXT_PUBLIC_REALTIME_URL`), because Next.js rewrites don't proxy WebSockets. In production, Nginx serves `/socket.io` on the same origin.
- **Accessibility gate:** the Playwright suite runs axe (WCAG 2.2 A/AA) on the sign-in, dashboard, directory, profile and teams pages, and fails on any serious or critical violation.

## 7. UX states checklist (every data view)

Loading skeleton matching the final layout · Empty state with a primary action · Error state
with a retry button and the `requestId` · Optimistic updates only for low-risk actions
(mark read, checklist). State transitions (clock, approve) wait for the server.
Destructive actions use `AlertDialog`. Mutations show a toast on success and failure.
Forms use RHF + the shared Zod schema and map server `details[].path` onto fields.
