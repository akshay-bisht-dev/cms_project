'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useMe } from '@/features/session/session-provider';
import { can } from '@/lib/permissions';

const SECTIONS = [
  { href: '/settings/organization', label: 'Organization' },
  { href: '/settings/attendance', label: 'Attendance & time' },
  { href: '/settings/monitoring', label: 'Monitoring', permission: 'monitoring.policy.read', scope: 'org' },
  { href: '/settings/sales', label: 'Sales & support', permission: 'opportunities.manage' },
  { href: '/settings/finance', label: 'Finance', permission: 'finance.rates.manage' },
  { href: '/settings/leave', label: 'Leave', permission: 'leave.policy.manage' },
  { href: '/settings/custom-fields', label: 'Custom fields', permission: 'customfields.manage' },
  { href: '/settings/integrations', label: 'Integrations' },
];

export function SettingsNav() {
  const pathname = usePathname();
  const me = useMe();
  const sections = SECTIONS.filter((s) => !s.permission || can(me, s.permission, s.scope));
  const nav = useRef(null);
  // On narrow screens the tab strip scrolls; keep the current section in view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  return (
    <nav ref={nav} aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto border-b">
      {sections.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          aria-current={pathname === s.href ? 'page' : undefined}
          className={cn('h-10 border-b-2 px-3 py-2 text-sm whitespace-nowrap', pathname === s.href ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
