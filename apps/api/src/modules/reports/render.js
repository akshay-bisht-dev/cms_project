import PDFDocument from 'pdfkit';
import { toCsv } from '../../utils/csv.js';

/** Plain-text value for exports: durations in decimal hours, ratios in percent. */
export function formatCell(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'duration') return (value / 3600).toFixed(2);
  if (type === 'percent') return (value * 100).toFixed(1);
  return String(value);
}

const headerFor = (c) => (c.type === 'duration' ? `${c.label} (h)` : c.type === 'percent' ? `${c.label} (%)` : c.label);

/** CSV with a totals row and, below it, how each figure was obtained (FR-ACT-3). */
export function reportCsv(result) {
  const { columns, rows, totals, meta } = result;
  return toCsv([
    columns.map(headerFor),
    ...rows.map((r) => columns.map((c) => formatCell(r[c.key], c.type))),
    ...(totals ? [columns.map((c, i) => (i === 0 ? 'Total' : formatCell(totals[c.key], c.type)))] : []),
    [],
    ['Report', result.title, 'Period', `${meta.from} to ${meta.to}`],
    ...columns.filter((c) => c.kind).map((c) => ['Column', c.label, 'Kind', c.kind]),
    ...meta.notes.map((n) => ['Note', n]),
  ]);
}

/** A landscape table PDF; long tables continue on new pages with the header repeated. */
export function reportPdf(result, { organizationName, generatedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: result.title } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { columns, rows, totals, meta } = result;
    const usable = doc.page.width - 72;
    const first = Math.min(200, usable * 0.28);
    const rest = (usable - first) / Math.max(1, columns.length - 1);
    const x = (i) => 36 + (i === 0 ? 0 : first + (i - 1) * rest);
    const w = (i) => (i === 0 ? first : rest) - 6;

    doc.fontSize(16).fillColor('#1C1830').text(result.title);
    doc.fontSize(9).fillColor('#5D5873').text(`${organizationName} · ${meta.from} to ${meta.to} · generated ${generatedAt.toISOString()}`);
    doc.moveDown();

    const header = () => {
      const y = doc.y;
      doc.fontSize(8).fillColor('#5D5873');
      columns.forEach((c, i) => doc.text(headerFor(c), x(i), y, { width: w(i), align: i === 0 ? 'left' : 'right' }));
      doc.moveDown(0.6).fillColor('#1C1830');
    };
    const line = (cells, bold = false) => {
      if (doc.y > doc.page.height - 60) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((v, i) => doc.text(v, x(i), y, { width: w(i), align: i === 0 ? 'left' : 'right', lineBreak: false, ellipsis: true }));
      doc.moveDown(0.5);
    };
    header();
    for (const r of rows) line(columns.map((c) => formatCell(r[c.key], c.type)));
    if (totals) line(columns.map((c, i) => (i === 0 ? 'Total' : formatCell(totals[c.key], c.type))), true);

    doc.font('Helvetica').moveDown().fontSize(8).fillColor('#5D5873');
    doc.text(`Measured: counted from records. Derived: calculated from measured values. ${columns.filter((c) => c.kind === 'derived').map((c) => c.label).join(', ') || 'None'} are derived.`, 36, doc.y, { width: usable });
    for (const n of meta.notes) doc.text(n, { width: usable });
    doc.end();
  });
}
