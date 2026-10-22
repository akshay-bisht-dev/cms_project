import { SystemStatus } from '@/features/system/system-status';

export const metadata = { title: 'System status' };

// Phase 2 landing page: confirms the web app can reach the API and its dependencies.
// Replaced by the authenticated dashboard redirect in Phase 3/4.
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-12 sm:px-6">
      <header className="flex items-center gap-3">
        <div aria-hidden className="grid size-10 place-items-center rounded-lg bg-sidebar text-lg font-bold text-sidebar-foreground">
          O
        </div>
        <div>
          <h1 className="text-xl font-semibold">Orbit</h1>
          <p className="text-sm text-muted-foreground">Platform foundation · Phase 2</p>
        </div>
      </header>
      <SystemStatus />
    </main>
  );
}
