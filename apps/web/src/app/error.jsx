'use client';

import { Button } from '@/components/ui/button';

export default function ErrorPage({ error, reset }) {
  return (
    <main className="mx-auto flex max-w-lg flex-col items-start gap-3 px-4 py-16">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        The page failed to load. Try again, and if it keeps happening, share this reference with support.
      </p>
      {error?.digest ? <code className="rounded bg-muted px-2 py-1 text-xs">{error.digest}</code> : null}
      <Button onClick={() => reset()}>Try again</Button>
    </main>
  );
}
