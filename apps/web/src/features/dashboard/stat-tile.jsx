import { Card } from '@/components/ui/card';

/** A headline number. `basis` states exactly what was counted, so readers never guess. */
export function StatTile({ label, value, basis, icon: Icon }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value ?? '—'}</p>
      {basis && <p className="mt-1 text-xs text-muted-foreground">{basis}</p>}
    </Card>
  );
}
