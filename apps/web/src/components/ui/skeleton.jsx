import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
