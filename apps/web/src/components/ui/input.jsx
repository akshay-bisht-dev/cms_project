import { cn } from '@/lib/utils';

function Input({ className, type = 'text', ...props }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn('flex min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground aria-[invalid=true]:border-danger', className)}
      {...props}
    />
  );
}

/** Native select: accessible and mobile-friendly by default. */
function NativeSelect({ className, children, ...props }) {
  return (
    <select
      data-slot="select"
      className={cn('flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs disabled:opacity-50 aria-[invalid=true]:border-danger', className)}
      {...props}
    >
      {children}
    </select>
  );
}

export { Input, NativeSelect, Textarea };
