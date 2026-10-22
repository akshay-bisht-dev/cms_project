'use client';

import { Label as LabelPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function Label({ className, ...props }) {
  return <LabelPrimitive.Root data-slot="label" className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

export { Label };
