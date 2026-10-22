import { idSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { sendCreated, sendOk } from '../../utils/response.js';
import { invoicePdf } from '../finance/invoice-pdf.js';

const text = (max) => z.string().trim().min(1).max(max);
const ticketParams = z.object({ ticketId: idSchema }).strict();
const invoiceParams = z.object({ invoiceId: idSchema }).strict();
// Every portal route is for client users only (allowClient); the service also refuses staff.
const portal = { permission: 'tickets.client', allowClient: true, tags: ['Client portal'] };

export function portalRoutes({ portalService }) {
  return defineRoutes('/portal', (r) => {
    r.get('/', { ...portal, summary: 'My client, open tickets and unpaid invoices' }, async (req, res) => {
      sendOk(res, await portalService.overview(req.ctx));
    });
    r.get('/projects', { ...portal, summary: 'Projects shared with my organization (status and milestones)' }, async (req, res) => {
      sendOk(res, await portalService.projects(req.ctx));
    });
    r.get('/tickets', { ...portal, summary: 'My organization’s tickets' }, async (req, res) => {
      sendOk(res, await portalService.tickets(req.ctx));
    });
    r.post('/tickets', { ...portal, body: z.object({ subject: text(200), description: text(20_000), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'), projectId: idSchema.optional() }).strict(), idempotent: true, summary: 'Raise a ticket' }, async (req, res) => {
      sendCreated(res, await portalService.createTicket(req.ctx, req.valid.body));
    });
    r.get('/tickets/:ticketId', { ...portal, params: ticketParams, summary: 'A ticket with public replies' }, async (req, res) => {
      sendOk(res, await portalService.ticket(req.ctx, req.valid.params.ticketId));
    });
    r.post('/tickets/:ticketId/comments', { ...portal, params: ticketParams, body: z.object({ body: text(20_000) }).strict(), summary: 'Reply on a ticket' }, async (req, res) => {
      sendCreated(res, await portalService.comment(req.ctx, req.valid.params.ticketId, req.valid.body));
    });
    r.get('/invoices', { ...portal, summary: 'Issued invoices' }, async (req, res) => {
      sendOk(res, await portalService.invoices(req.ctx));
    });
    r.get('/invoices/:invoiceId', { ...portal, params: invoiceParams, summary: 'An issued invoice' }, async (req, res) => {
      sendOk(res, (await portalService.invoice(req.ctx, req.valid.params.invoiceId)).invoice);
    });
    r.get('/invoices/:invoiceId/pdf', { ...portal, params: invoiceParams, summary: 'Invoice PDF' }, async (req, res) => {
      const data = await portalService.invoice(req.ctx, req.valid.params.invoiceId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${data.invoice.number}.pdf"`);
      res.send(await invoicePdf(data));
    });
  });
}
