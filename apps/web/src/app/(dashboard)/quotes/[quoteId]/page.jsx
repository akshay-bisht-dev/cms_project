import { QuoteDetail } from '@/features/crm/sales-pages';

export const metadata = { title: 'Quote' };

export default async function Page({ params }) {
  const { quoteId } = await params;
  return <QuoteDetail quoteId={quoteId} />;
}
