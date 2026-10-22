'use client';

import { AlertDialog as AlertPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

const AlertDialog = AlertPrimitive.Root;
const AlertDialogTrigger = AlertPrimitive.Trigger;

function AlertDialogContent({ className, ...props }) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <AlertPrimitive.Content
        className={cn('fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-card p-6 shadow-lg', className)}
        {...props}
      />
    </AlertPrimitive.Portal>
  );
}

const AlertDialogTitle = ({ className, ...props }) => <AlertPrimitive.Title className={cn('text-lg font-semibold', className)} {...props} />;
const AlertDialogDescription = ({ className, ...props }) => <AlertPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
const AlertDialogFooter = ({ className, ...props }) => <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
const AlertDialogCancel = ({ className, ...props }) => <AlertPrimitive.Cancel className={cn(buttonVariants({ variant: 'outline' }), className)} {...props} />;
const AlertDialogAction = ({ className, destructive, ...props }) => (
  <AlertPrimitive.Action className={cn(buttonVariants({ variant: destructive ? 'destructive' : 'default' }), className)} {...props} />
);

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger };
