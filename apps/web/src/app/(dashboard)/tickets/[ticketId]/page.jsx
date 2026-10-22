import { TicketDetail } from '@/features/tickets/tickets-pages';

export const metadata = { title: 'Ticket' };

export default async function Page({ params }) {
  const { ticketId } = await params;
  return <TicketDetail ticketId={ticketId} />;
}
