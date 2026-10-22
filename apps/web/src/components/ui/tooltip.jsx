'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

const TooltipProvider = ({ delayDuration = 200, ...props }) => <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;

function Tooltip({ content, side = 'right', children }) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn('z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md')}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
