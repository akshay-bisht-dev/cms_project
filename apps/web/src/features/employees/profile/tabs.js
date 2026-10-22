// Profile tabs (inspired by the reference layout). `phase` marks tabs whose module is not built
// yet: they render disabled with that note instead of empty or invented content.
export const PROFILE_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'time-off', label: 'Time Off' },
  { id: 'profile', label: 'Profile' },
  { id: 'app-settings', label: 'App Settings' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'activity', label: 'Activity' },
  { id: 'projects', label: 'Projects' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'timesheets', label: 'Timesheets' },
  { id: 'screenshots', label: 'Screenshots' },
  { id: 'documents', label: 'Documents' },
];

export const AVAILABLE_TABS = new Set(PROFILE_TABS.filter((t) => !t.phase).map((t) => t.id));
