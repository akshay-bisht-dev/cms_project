import PDFDocument from 'pdfkit';
import { toCsv } from '../../utils/csv.js';

const hours = (s) => (s / 3600).toFixed(2);

export function timesheetCsv(sheet, zone) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' });
  return toCsv([
    ['employee', 'period_start', 'period_end', 'status', 'started_at_local', 'ended_at_local', 'hours', 'billable', 'description'],
    ...sheet.entries.map((e) => [
      sheet.employee?.name,
      sheet.periodStart,
      sheet.periodEnd,
      sheet.status,
      fmt.format(new Date(e.startedAt)),
      fmt.format(new Date(e.endedAt)),
      hours(e.durationS),
      e.isBillable ? 'yes' : 'no',
      e.description,
    ]),
    [],
    ['total_hours', hours(sheet.totalS), 'billable_hours', hours(sheet.billableS)],
  ]);
}

/** Renders a one-section PDF and resolves with its bytes. */
export function timesheetPdf(sheet, { organizationName, zone }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Timesheet ${sheet.periodStart}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    doc.fontSize(18).text('Timesheet');
    doc.moveDown(0.3).fontSize(10).fillColor('#5D5873');
    doc.text(`${organizationName} · ${sheet.employee?.name ?? ''}`);
    doc.text(`Period ${sheet.periodStart} to ${sheet.periodEnd} · Status ${sheet.status} · Times in ${zone}`);
    doc.moveDown().fillColor('#1C1830').fontSize(11);
    doc.text(`Total ${hours(sheet.totalS)} h   Billable ${hours(sheet.billableS)} h   Non-billable ${hours(sheet.totalS - sheet.billableS)} h`);
    doc.moveDown();

    const cols = [48, 190, 330, 385, 440];
    const header = ['Start', 'End', 'Hours', 'Billable', 'Description'];
    doc.fontSize(9).fillColor('#5D5873');
    header.forEach((h, i) => doc.text(h, cols[i], doc.y, { continued: false, lineBreak: false }));
    doc.moveDown(0.8);
    doc.fillColor('#1C1830');
    for (const e of sheet.entries) {
      if (doc.y > 760) doc.addPage();
      const y = doc.y;
      doc.text(fmt.format(new Date(e.startedAt)), cols[0], y, { width: 135, lineBreak: false });
      doc.text(fmt.format(new Date(e.endedAt)), cols[1], y, { width: 135, lineBreak: false });
      doc.text(hours(e.durationS), cols[2], y, { width: 50, lineBreak: false });
      doc.text(e.isBillable ? 'Yes' : 'No', cols[3], y, { width: 50, lineBreak: false });
      doc.text(e.description ?? '', cols[4], y, { width: 110, height: 12, ellipsis: true });
      doc.moveDown(0.4);
    }
    if (sheet.history.length) {
      doc.moveDown().fontSize(10).fillColor('#5D5873').text('History');
      doc.fillColor('#1C1830').fontSize(9);
      for (const h of sheet.history) doc.text(`${new Date(h.createdAt).toISOString()}  ${h.action}  ${h.actor?.name ?? ''}${h.comment ? `: ${h.comment}` : ''}`);
    }
    doc.end();
  });
}
