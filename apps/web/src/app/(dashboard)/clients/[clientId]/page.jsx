import { ClientDetail } from '@/features/crm/client-detail';

export const metadata = { title: 'Client' };

export default async function Page({ params }) {
  const { clientId } = await params;
  return <ClientDetail clientId={clientId} />;
}
