import { CircleAlert, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="size-10 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <CircleAlert className="size-10 text-danger" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {error?.message ?? 'The request failed.'}
        {error?.requestId ? <span className="mt-1 block font-mono text-xs">Reference: {error.requestId}</span> : null}
      </p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
