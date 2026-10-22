import PDFDocument from 'pdfkit';

/** Renders an invoice (as serialized) to PDF bytes. Drafts carry a DRAFT watermark. */
export function invoicePdf({ invoice, organization, client }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: invoice.number ? `Invoice ${invoice.number}` : 'Draft invoice' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#1C1830';
    const muted = '#5D5873';
    if (invoice.status === 'DRAFT' || invoice.status === 'VOID') {
      doc.save().rotate(-30, { origin: [300, 420] }).fontSize(96).fillColor('#E6E4EE').text(invoice.status, 80, 380, { width: 450, align: 'center' }).restore();
    }
    doc.fillColor(ink).fontSize(20).text(organization.name, 48, 48);
    doc.fontSize(10).fillColor(muted).text(invoice.number ? `Invoice ${invoice.number}` : 'Draft invoice', { align: 'right' });
    doc.moveDown();
    doc.fillColor(ink).fontSize(10).text(`Bill to: ${client.name}`);
    if (client.taxId) doc.text(`Tax ID: ${client.taxId}`);
    if (client.email) doc.text(client.email);
    doc.moveDown(0.5).fillColor(muted);
    doc.text(`Issued: ${invoice.issueDate ?? '—'}    Due: ${invoice.dueDate ?? '—'}    Currency: ${invoice.currency}`);
    doc.moveDown();

    const cols = [48, 300, 360, 430, 490];
    const header = ['Description', 'Qty', 'Unit price', 'Tax', 'Amount'];
    let y = doc.y;
    doc.fontSize(9).fillColor(muted);
    header.forEach((h, i) => doc.text(h, cols[i], y, { width: i === 0 ? 245 : 55, align: i === 0 ? 'left' : 'right' }));
    doc.moveDown(0.8).fillColor(ink);
    for (const item of invoice.items) {
      if (doc.y > 720) doc.addPage();
      y = doc.y;
      doc.text(item.description, cols[0], y, { width: 245 });
      const after = doc.y;
      doc.text(Number(item.quantity).toString(), cols[1], y, { width: 55, align: 'right' });
      doc.text(item.unitPrice.replace(/\.?0+$/, ''), cols[2], y, { width: 65, align: 'right' });
      doc.text(`${(Number(item.taxRate) * 100).toFixed(2).replace(/\.00$/, '')}%`, cols[3], y, { width: 55, align: 'right' });
      doc.text(item.lineTotal, cols[4], y, { width: 55, align: 'right' });
      doc.y = Math.max(after, doc.y) + 4;
    }
    doc.moveDown();
    const totals = [
      ['Subtotal', invoice.subtotal],
      ['Tax', invoice.taxTotal],
      ['Total', invoice.total],
      ['Paid', invoice.amountPaid],
      ['Amount due', invoice.outstanding],
    ];
    for (const [label, value] of totals) {
      y = doc.y;
      doc.font(label === 'Amount due' ? 'Helvetica-Bold' : 'Helvetica').text(label, 360, y, { width: 120, align: 'right' });
      doc.text(`${value} ${invoice.currency}`, 480, y, { width: 65, align: 'right' });
      doc.moveDown(0.3);
    }
    if (invoice.notes) {
      doc.font('Helvetica').moveDown().fillColor(muted).text(invoice.notes, 48, doc.y, { width: 500 });
    }
    doc.end();
  });
}
