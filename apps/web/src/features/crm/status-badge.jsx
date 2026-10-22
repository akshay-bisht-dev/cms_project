import { Badge } from '@/components/ui/badge';

/** Badge for a status from one of the label maps in ./labels.js. */
export function StatusBadge({ map, value, children }) {
  const [label, tone] = map[value] ?? [value, 'neutral'];
  return (
    <Badge tone={tone}>
      {label}
      {children}
    </Badge>
  );
}
