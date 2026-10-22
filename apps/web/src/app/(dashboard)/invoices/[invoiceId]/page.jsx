import { InvoiceDetail } from '@/features/finance/invoices-pages';

export const metadata = { title: 'Invoice' };

export default async function Page({ params }) {
  const { invoiceId } = await params;
  return <InvoiceDetail invoiceId={invoiceId} />;
}
