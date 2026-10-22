'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Per-browser UI preferences (sidebar state). Not used for anything that must be shared or reliable. */
export const useUiStore = create(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      collapsedGroups: {},
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleGroup: (group) => set((s) => ({ collapsedGroups: { ...s.collapsedGroups, [group]: !s.collapsedGroups[group] } })),
    }),
    { name: 'orbit-ui', storage: createJSONStorage(() => localStorage) },
  ),
);
