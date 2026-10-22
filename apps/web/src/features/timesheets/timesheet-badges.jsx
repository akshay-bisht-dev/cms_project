import { CircleCheck, CircleDashed, Send, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const STYLES = {
  DRAFT: { tone: 'neutral', Icon: CircleDashed, label: 'Draft' },
  SUBMITTED: { tone: 'info', Icon: Send, label: 'Submitted' },
  APPROVED: { tone: 'success', Icon: CircleCheck, label: 'Approved' },
  REJECTED: { tone: 'danger', Icon: Undo2, label: 'Returned' },
};

export function TimesheetStatus({ status }) {
  const s = STYLES[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}
