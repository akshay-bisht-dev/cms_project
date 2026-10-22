export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto max-w-3xl space-y-3 px-4 py-12">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
