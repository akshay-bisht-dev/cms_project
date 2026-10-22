import {
  Bell, BriefcaseBusiness, Building, Building2, Columns3, FileSignature, UserRoundPlus, Wallet, CalendarDays, Camera, ChartColumn, ChartNoAxesCombined, ClipboardList,
  Clock, FileText, FolderKanban, ListChecks, Gauge, History, House, LifeBuoy, ListTodo, Plug, Receipt,
  Settings, ShieldCheck, SlidersHorizontal, Sparkles, Timer, Plane, Users, UsersRound,
} from 'lucide-react';

/**
 * Sidebar navigation. `permission`: shown only if the user holds it (any scope). `phase`: the
 * roadmap phase that builds the module; until then the item is shown disabled with that note,
 * so the layout matches the final product without linking to pages that do not exist.
 */
export const NAV_GROUPS = [
  {
    id: 'work',
    label: 'Work',
    items: [
      { label: 'My Dashboard', href: '/my-dashboard', icon: House },
      { label: 'Dashboard', href: '/dashboard', icon: Gauge, permission: 'dashboard.read' },
      { label: 'Project Management', href: '/project-management', icon: FolderKanban, permission: 'projects.read' },
      { label: 'Timesheets', href: '/timesheets', icon: ClipboardList, permission: 'timesheets.read' },
      { label: 'Activity', href: '/activity', icon: ChartNoAxesCombined, permission: 'reports.attendance.read' },
      { label: 'Insights', href: '/insights', icon: Sparkles, permission: 'reports.attendance.read' },
      { label: 'Reports', href: '/reports', icon: ChartColumn, permission: 'reports.export' },
      { label: 'Calendar', href: '/calendar', icon: CalendarDays },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      { label: 'Projects', href: '/projects', icon: BriefcaseBusiness, permission: 'projects.read' },
      { label: 'Tasks', href: '/tasks', icon: ListTodo, permission: 'tasks.read' },
      { label: 'Support Tickets', href: '/tickets', icon: LifeBuoy, permission: 'tickets.read' },
    ],
  },
  {
    id: 'crm',
    label: 'Clients & sales',
    items: [
      { label: 'Clients', href: '/clients', icon: Building, permission: 'clients.read' },
      { label: 'Leads', href: '/leads', icon: UserRoundPlus, permission: 'leads.manage' },
      { label: 'Pipeline', href: '/pipeline', icon: Columns3, permission: 'opportunities.manage' },
      { label: 'Quotes', href: '/quotes', icon: FileSignature, permission: 'quotes.manage' },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    items: [
      { label: 'Invoices', href: '/invoices', icon: Receipt, permission: 'finance.invoices.read' },
      { label: 'Expenses', href: '/expenses', icon: Wallet, permission: 'finance.expenses.submit' },
    ],
  },
  {
    id: 'people',
    label: 'People',
    items: [
      { label: 'People', href: '/employees', icon: Users, permission: 'employees.read' },
      { label: 'Departments', href: '/departments', icon: Building2, permission: 'employees.read' },
      { label: 'Teams', href: '/teams', icon: UsersRound, permission: 'employees.read' },
      { label: 'Attendance', href: '/attendance', icon: Clock, permission: 'attendance.self' },
      { label: 'Time Off', href: '/leave', icon: Plane, permission: 'leave.self' },
      { label: 'Screenshots', href: '/screenshots', icon: Camera, permission: 'monitoring.screenshots.read' },
      { label: 'My Monitoring', href: '/monitoring', icon: ShieldCheck, permission: 'monitoring.self' },
      { label: 'Time Tracking', href: '/time', icon: Timer, permission: 'time.self' },
      { label: 'Documents', href: '/documents', icon: FileText, permission: 'documents.hr.manage' },
      { label: 'Checklists', href: '/checklists', icon: ListChecks, permission: 'employees.read' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { label: 'Notifications', href: '/notifications', icon: Bell },
      { label: 'Settings', href: '/settings/organization', icon: Settings, permission: 'org.settings.read' },
      { label: 'Custom Fields', href: '/settings/custom-fields', icon: SlidersHorizontal, permission: 'customfields.manage' },
      { label: 'Integrations', href: '/settings/integrations', icon: Plug },
      { label: 'Audit Logs', href: '/audit-logs', icon: History, permission: 'audit.read' },
    ],
  },
];
