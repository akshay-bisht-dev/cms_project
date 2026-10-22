'use client';

import { DropdownMenu as Menu } from 'radix-ui';
import { cn } from '@/lib/utils';

const DropdownMenu = Menu.Root;
const DropdownMenuTrigger = Menu.Trigger;

function DropdownMenuContent({ className, align = 'end', ...props }) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={6}
        className={cn('z-50 min-w-48 overflow-hidden rounded-md border bg-card p-1 text-sm shadow-md', className)}
        {...props}
      />
    </Menu.Portal>
  );
}

function DropdownMenuItem({ className, ...props }) {
  return (
    <Menu.Item
      className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4', className)}
      {...props}
    />
  );
}

const DropdownMenuLabel = ({ className, ...props }) => <Menu.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
const DropdownMenuSeparator = ({ className, ...props }) => <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger };
