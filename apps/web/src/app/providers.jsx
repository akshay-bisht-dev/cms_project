'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export function Providers({ children }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Client errors (4xx) will not succeed on retry.
            retry: (count, error) => (error?.status >= 400 && error?.status < 500 ? false : count < 2),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
      {/* Neutral toasts: the library's "rich colors" fall below 4.5:1 contrast; icons convey the type. */}
      <Toaster position="bottom-right" closeButton />
    </QueryClientProvider>
  );
}
