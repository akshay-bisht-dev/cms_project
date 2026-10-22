import { redirect } from 'next/navigation';
import { getMe } from '@/services/server-api';
import { SessionProvider } from '@/features/session/session-provider';
import { PortalShell } from '@/features/portal/portal-shell';

// The client portal: only client users (member type CLIENT); staff are sent to their dashboard.
export default async function PortalLayout({ children }) {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.session.mfaPending) redirect('/login?step=mfa');
  if (!me.organization) redirect('/login?step=organization');
  if (me.memberType !== 'CLIENT') redirect('/my-dashboard');
  return (
    <SessionProvider initialMe={me}>
      <PortalShell>{children}</PortalShell>
    </SessionProvider>
  );
}
