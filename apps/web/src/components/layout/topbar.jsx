'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, ChevronsUpDown, LogOut, Menu, ShieldCheck, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { TimeControl } from '@/features/time/time-control';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';

function OrganizationSwitcher() {
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  if (me.organizations.length < 2) {
    return <span className="hidden truncate text-sm font-medium sm:inline">{me.organization.name}</span>;
  }
  async function switchTo(organizationId) {
    try {
      await api.post('/auth/select-organization', { organizationId });
      queryClient.clear();
      router.push('/my-dashboard');
      router.refresh();
    } catch (error) {
      toast.error(error.message);
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-56 gap-2">
          <Building2 aria-hidden />
          <span className="truncate">{me.organization.name}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
        {me.organizations.map((org) => (
          <DropdownMenuItem key={org.id} onSelect={() => org.id !== me.organization.id && switchTo(org.id)}>
            {org.name}
            {org.id === me.organization.id && <Check className="ml-auto" aria-label="current" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Account menu. The client portal reuses it with its own security page and no profile link. */
export function UserMenu({ securityHref = '/account/security', showProfile = true }) {
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  async function signOut() {
    await api.post('/auth/logout').catch(() => {});
    queryClient.clear();
    router.replace('/login');
    router.refresh();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rounded-full">
          <Avatar name={me.user.name} size="sm" />
          <span className="sr-only">Account menu for {me.user.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="text-foreground">
          <span className="block text-sm font-medium">{me.user.name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {showProfile && me.employeeId && (
          <DropdownMenuItem asChild>
            <Link href={`/employees/${me.employeeId}/profile`}>
              <UserRound aria-hidden /> My profile
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={securityHref}>
            <ShieldCheck aria-hidden /> Security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ onOpenMenu }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-4 backdrop-blur lg:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMenu} aria-label="Open navigation">
        <Menu aria-hidden />
      </Button>
      <OrganizationSwitcher />
      <div className="ml-auto flex items-center gap-2">
        <TimeControl />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
