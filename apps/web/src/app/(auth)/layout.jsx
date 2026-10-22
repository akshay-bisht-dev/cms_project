export default function AuthLayout({ children }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span aria-hidden className="grid size-9 place-items-center rounded-lg bg-sidebar text-lg font-bold text-sidebar-foreground">O</span>
        <span className="text-lg font-semibold">Orbit</span>
      </div>
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
