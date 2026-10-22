import { cn } from '@/lib/utils';

function Card({ className, ...props }) {
  return <div data-slot="card" className={cn('rounded-lg border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}

function CardHeader({ className, ...props }) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

function CardTitle({ className, ...props }) {
  return <h2 data-slot="card-title" className={cn('text-base font-semibold', className)} {...props} />;
}

function CardDescription({ className, ...props }) {
  return <p data-slot="card-description" className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function CardContent({ className, ...props }) {
  return <div data-slot="card-content" className={cn('p-5 pt-0', className)} {...props} />;
}

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
