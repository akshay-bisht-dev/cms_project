import { CalendarOff, CircleCheck, CircleDashed, Clock, Coffee, LogOut, PartyPopper, TriangleAlert, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const PRESENCE = {
  WORKING: { label: 'Working', tone: 'success', Icon: Clock },
  ON_BREAK: { label: 'On break', tone: 'warning', Icon: Coffee },
  CLOCKED_OUT: { label: 'Clocked out', tone: 'neutral', Icon: LogOut },
  ABSENT: { label: 'Absent', tone: 'danger', Icon: UserX },
  NOT_STARTED: { label: 'Not started', tone: 'neutral', Icon: CircleDashed },
  NOT_SCHEDULED: { label: 'Not scheduled', tone: 'neutral', Icon: CalendarOff },
  HOLIDAY: { label: 'Holiday', tone: 'info', Icon: PartyPopper },
  PRESENT: { label: 'Present', tone: 'success', Icon: CircleCheck },
};

export function PresenceBadge({ value }) {
  const p = PRESENCE[value] ?? { label: value, tone: 'neutral', Icon: CircleDashed };
  return (
    <Badge tone={p.tone}>
      <p.Icon className="size-3.5" aria-hidden />
      {p.label}
    </Badge>
  );
}

const FLAG_LABEL = { LATE: 'Late', EARLY_LEAVE: 'Left early', MISSED_CLOCK_OUT: 'Missed clock-out', CORRECTED: 'Corrected' };

export function FlagBadges({ flags }) {
  return (flags ?? []).map((f) => (
    <Badge key={f} tone={f === 'CORRECTED' ? 'info' : 'warning'}>
      {f !== 'CORRECTED' && <TriangleAlert className="size-3.5" aria-hidden />}
      {FLAG_LABEL[f] ?? f}
    </Badge>
  ));
}

const CORRECTION_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };
export function CorrectionStatus({ status }) {
  return <Badge tone={CORRECTION_TONE[status]}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}
