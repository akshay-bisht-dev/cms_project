import { ArrowDown, ArrowUp, ChevronsUp, CircleCheck, CircleDashed, CircleDot, CircleSlash, Minus, PauseCircle, PlayCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const PROJECT = {
  PLANNED: { label: 'Planned', tone: 'neutral', Icon: CircleDashed },
  ACTIVE: { label: 'Active', tone: 'success', Icon: PlayCircle },
  ON_HOLD: { label: 'On hold', tone: 'warning', Icon: PauseCircle },
  COMPLETED: { label: 'Completed', tone: 'info', Icon: CircleCheck },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', Icon: XCircle },
};

export function ProjectStatusBadge({ status }) {
  const s = PROJECT[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

const PRIORITY = {
  LOW: { label: 'Low', Icon: ArrowDown, className: 'text-muted-foreground' },
  MEDIUM: { label: 'Medium', Icon: Minus, className: 'text-muted-foreground' },
  HIGH: { label: 'High', Icon: ArrowUp, className: 'text-warning' },
  URGENT: { label: 'Urgent', Icon: ChevronsUp, className: 'text-danger' },
};

export function PriorityLabel({ priority, compact = false }) {
  const p = PRIORITY[priority];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${p.className}`}>
      <p.Icon className="size-3.5" aria-hidden />
      <span className={compact ? 'sr-only' : undefined}>{p.label}</span>
      {compact && <span className="sr-only"> priority</span>}
    </span>
  );
}

const CATEGORY = {
  TODO: { tone: 'neutral', Icon: CircleDashed },
  IN_PROGRESS: { tone: 'info', Icon: CircleDot },
  DONE: { tone: 'success', Icon: CircleCheck },
  CANCELLED: { tone: 'neutral', Icon: CircleSlash },
};

export function TaskStatusBadge({ status }) {
  const c = CATEGORY[status.category];
  return (
    <Badge tone={c.tone}>
      <c.Icon className="size-3.5" aria-hidden />
      {status.name}
    </Badge>
  );
}

export const PRIORITIES = Object.keys(PRIORITY).map((value) => ({ value, label: PRIORITY[value].label }));
export const PROJECT_STATUSES = Object.keys(PROJECT).map((value) => ({ value, label: PROJECT[value].label }));
