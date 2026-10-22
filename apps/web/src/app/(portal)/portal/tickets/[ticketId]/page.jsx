import { PortalTicket } from '@/features/portal/portal-pages';

export const metadata = { title: 'Ticket' };

export default async function Page({ params }) {
  const { ticketId } = await params;
  return <PortalTicket ticketId={ticketId} />;
}
