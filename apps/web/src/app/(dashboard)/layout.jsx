import { redirect } from 'next/navigation';
import { getMe } from '@/services/server-api';
import { AppShell } from '@/components/layout/app-shell';
import { SessionProvider } from '@/features/session/session-provider';
import { RealtimeProvider } from '@/features/notifications/realtime-provider';

// Server-side gate: every signed-in page needs a session with an active organization. The API
// still authorizes each request; this only decides which screen to show.
export default async function DashboardLayout({ children }) {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.session.mfaPending) redirect('/login?step=mfa');
  if (!me.organization) redirect('/login?step=organization');
  if (me.mfaEnrollmentRequired) redirect('/setup-mfa');
  // Client users have their own portal; the internal app is never shown to them.
  if (me.memberType === 'CLIENT') redirect('/portal');

  return (
    <SessionProvider initialMe={me}>
      <RealtimeProvider organizationId={me.organization.id}>
        <AppShell>{children}</AppShell>
      </RealtimeProvider>
    </SessionProvider>
  );
}
