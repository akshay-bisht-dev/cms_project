'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserMenu } from '@/components/layout/topbar';
import { useMe } from '@/features/session/session-provider';
import { cn } from '@/lib/utils';

const LINKS = [
  ['/portal', 'Overview'],
  ['/portal/tickets', 'Support'],
  ['/portal/invoices', 'Invoices'],
];

/** A deliberately small shell: the portal never links into the internal app. */
export function PortalShell({ children }) {
  const me = useMe();
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <p className="font-semibold">
            {me.organization.name} <span className="font-normal text-muted-foreground">· client portal</span>
          </p>
          <nav aria-label="Portal" className="flex flex-1 gap-1">
            {LINKS.map(([href, label]) => {
              const active = href === '/portal' ? pathname === href : pathname.startsWith(href);
              return (
                <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('rounded-md px-3 py-1.5 text-sm', active ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {label}
                </Link>
              );
            })}
          </nav>
          <UserMenu securityHref="/portal/account" showProfile={false} />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
