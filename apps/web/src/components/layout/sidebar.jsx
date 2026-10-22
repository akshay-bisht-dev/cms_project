'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useMe } from '@/features/session/session-provider';
import { can } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { NAV_GROUPS } from './nav-config';

function NavItem({ item, active, collapsed, onNavigate }) {
  const Icon = item.icon;
  const disabled = !item.href;
  // The accessible name always starts with the visible label (WCAG 2.5.3); the phase note is
  // screen-reader text and the "P5" badge is decorative.
  const content = (
    <>
      <Icon className="size-[18px] shrink-0" aria-hidden />
      <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
      {disabled && <span className="sr-only"> (available in Phase {item.phase})</span>}
      {!collapsed && disabled && (
        <span aria-hidden className="ml-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">
          P{item.phase}
        </span>
      )}
    </>
  );
  const classes = cn(
    'relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors',
    collapsed && 'justify-center px-0',
    active && 'bg-sidebar-active font-medium text-white before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-1 before:rounded-r before:bg-[#B9A6FF]',
    !active && !disabled && 'text-sidebar-foreground/90 hover:bg-white/10 hover:text-white',
    disabled && 'cursor-not-allowed text-sidebar-foreground/70',
  );
  const tooltip = disabled ? `${item.label}: available in Phase ${item.phase}` : collapsed ? item.label : null;

  return (
    <li>
      <Tooltip content={tooltip}>
        {disabled ? (
          <span role="link" aria-disabled="true" tabIndex={0} className={classes}>
            {content}
          </span>
        ) : (
          <Link href={item.href} aria-current={active ? 'page' : undefined} className={classes} onClick={onNavigate}>
            {content}
          </Link>
        )}
      </Tooltip>
    </li>
  );
}

export function Sidebar({ mobile = false, onNavigate }) {
  const me = useMe();
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar, collapsedGroups, toggleGroup } = useUiStore();
  const collapsed = !mobile && sidebarCollapsed;

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || can(me, item.permission)),
  })).filter((g) => g.items.length > 0);

  return (
    <nav aria-label="Main" className={cn('flex h-full flex-col bg-sidebar text-sidebar-foreground', collapsed ? 'w-[72px]' : 'w-64')}>
      <div className={cn('flex h-14 items-center gap-2 border-b border-white/10 px-4', collapsed && 'justify-center px-0')}>
        <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-[#B9A6FF] font-bold text-sidebar">O</span>
        {!collapsed && <span className="text-base font-semibold text-white">Orbit</span>}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {groups.map((group) => {
          const open = collapsed || !collapsedGroups[group.id];
          return (
            <div key={group.id} className="mb-3">
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between px-3 py-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/70 uppercase hover:text-white"
                >
                  {group.label}
                  <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
                </button>
              )}
              {open && (
                <ul className="mt-1 space-y-0.5">
                  {group.items.map((item) => (
                    <NavItem
                      key={item.label}
                      item={item}
                      collapsed={collapsed}
                      onNavigate={onNavigate}
                      active={Boolean(item.href) && (pathname === item.href || pathname.startsWith(`${item.href}/`))}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {!mobile && (
        <div className="border-t border-white/10 p-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className={cn('flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/90 hover:bg-white/10', collapsed && 'justify-center px-0')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" aria-hidden /> : <PanelLeftClose className="size-[18px]" aria-hidden />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      )}
    </nav>
  );
}
