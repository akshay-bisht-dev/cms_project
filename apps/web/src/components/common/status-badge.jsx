import { CircleCheck, CircleDashed, CircleMinus, CirclePause, Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { MEMBER_STATUS_LABEL } from '@/lib/format';

// Status is always conveyed by text and icon, never by color alone (WCAG 1.4.1).
const STYLES = {
  ACTIVE: { tone: 'success', Icon: CircleCheck },
  INVITED: { tone: 'info', Icon: Mail },
  SUSPENDED: { tone: 'warning', Icon: CirclePause },
  DEACTIVATED: { tone: 'neutral', Icon: CircleMinus },
  ARCHIVED: { tone: 'neutral', Icon: CircleDashed },
};

export function MemberStatusBadge({ status }) {
  const { tone, Icon } = STYLES[status] ?? STYLES.ARCHIVED;
  return (
    <Badge tone={tone}>
      <Icon className="size-3.5" aria-hidden />
      {MEMBER_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
