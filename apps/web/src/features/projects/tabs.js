// Project page tabs. Kept in a plain module (not 'use client') so the server route can validate
// the URL segment: exports of client modules are only references on the server.
export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'members', label: 'Members' },
  { id: 'settings', label: 'Settings' },
];
