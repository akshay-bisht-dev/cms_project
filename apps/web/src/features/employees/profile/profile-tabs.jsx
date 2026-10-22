import Link from 'next/link';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PROFILE_TABS } from './tabs';

export function ProfileTabs({ employeeId, active }) {
  return (
    <nav aria-label="Profile sections" className="mb-4 overflow-x-auto border-b">
      <ul className="flex min-w-max gap-1">
        {PROFILE_TABS.map((tab) => {
          const classes = cn(
            'inline-flex h-10 items-center border-b-2 px-3 text-sm whitespace-nowrap',
            tab.id === active ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground',
          );
          return (
            <li key={tab.id}>
              {tab.phase ? (
                <Tooltip content={`Available in Phase ${tab.phase}`} side="bottom">
                  <span role="link" aria-disabled="true" tabIndex={0} className={cn(classes, 'cursor-not-allowed text-muted-foreground/60')}>
                    {tab.label}
                    <span className="sr-only"> (available in Phase {tab.phase})</span>
                  </span>
                </Tooltip>
              ) : (
                <Link href={`/employees/${employeeId}/${tab.id}`} aria-current={tab.id === active ? 'page' : undefined} className={cn(classes, 'hover:text-foreground')}>
                  {tab.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
