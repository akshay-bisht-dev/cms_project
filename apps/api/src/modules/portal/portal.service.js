import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { withTransaction } from '../../repositories/tx.js';
import { isoDate, localDate } from '../../utils/time.js';
import { serializeInvoice } from '../finance/invoices.service.js';

/**
 * The client portal: a CLIENT member sees only their own client's data — shared projects
 * (status and milestones), their client's tickets (public comments only) and issued invoices.
 * Every query is filtered by the member's client id taken from the membership, never the request.
 */
export function createPortalService({ prisma, clock, ticketService }) {
  function clientOf(ctx) {
    if (ctx.member?.memberType !== 'CLIENT' || !ctx.member.clientId) throw new ForbiddenError('The client portal is for client users');
    return ctx.member.clientId;
  }
  const today = (ctx) => localDate(clock.now(), ctx.organization?.timeZone ?? 'UTC');

  async function loadTicket(db, ctx, ticketId) {
    const ticket = await db.supportTicket.findFirst({ where: { organizationId: ctx.orgId, id: ticketId, clientId: clientOf(ctx) }, include: { client: true } });
    if (!ticket) throw new NotFoundError('Ticket not found');
    return ticket;
  }

  return {
    async overview(ctx) {
      const clientId = clientOf(ctx);
      const client = await prisma.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } });
      const [openTickets, unpaid] = await Promise.all([
        prisma.supportTicket.count({ where: { organizationId: ctx.orgId, clientId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT'] } } }),
        prisma.invoice.count({ where: { organizationId: ctx.orgId, clientId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } }),
      ]);
      return { client: { id: client.id, name: client.name }, organization: { name: ctx.organization.name }, openTickets, unpaidInvoices: unpaid };
    },

    async projects(ctx) {
      const rows = await prisma.project.findMany({
        where: { organizationId: ctx.orgId, clientId: clientOf(ctx), sharedWithClient: true, archivedAt: null },
        include: { milestones: { orderBy: { dueDate: 'asc' } } },
        orderBy: { name: 'asc' },
      });
      return rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
        startDate: p.startDate ? isoDate(p.startDate) : null,
        deadline: p.deadline ? isoDate(p.deadline) : null,
        milestones: p.milestones.map((m) => ({ name: m.name, dueDate: m.dueDate ? isoDate(m.dueDate) : null, done: Boolean(m.completedAt) })),
      }));
    },

    async tickets(ctx) {
      const rows = await prisma.supportTicket.findMany({ where: { organizationId: ctx.orgId, clientId: clientOf(ctx) }, include: { client: true }, orderBy: { createdAt: 'desc' }, take: 300 });
      return Promise.all(rows.map((t) => ticketService.serialize(prisma, ctx, t, { portal: true })));
    },

    async ticket(ctx, ticketId) {
      const ticket = await loadTicket(prisma, ctx, ticketId);
      const comments = await prisma.ticketComment.findMany({ where: { organizationId: ctx.orgId, ticketId: ticket.id, visibility: 'PUBLIC' }, orderBy: { createdAt: 'asc' } });
      return ticketService.serialize(prisma, ctx, ticket, { comments, portal: true });
    },

    async createTicket(ctx, { subject, description, priority, projectId }) {
      const clientId = clientOf(ctx);
      return withTransaction(prisma, async (tx) => {
        if (projectId && !(await tx.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId, clientId, sharedWithClient: true } }))) throw new NotFoundError('Project not found');
        const ticket = await ticketService.createTicket(tx, ctx, { subject, description, priority, clientId, projectId: projectId ?? null });
        return ticketService.serialize(tx, ctx, ticket, { portal: true });
      });
    },

    async comment(ctx, ticketId, { body }) {
      return withTransaction(prisma, async (tx) => {
        const ticket = await loadTicket(tx, ctx, ticketId);
        if (ticket.status === 'CLOSED') throw new ForbiddenError('This ticket is closed; open a new one');
        const comment = await ticketService.addComment(tx, ctx, ticket, { body, visibility: 'PUBLIC' }, { fromClient: true });
        return { id: comment.id };
      });
    },

    async invoices(ctx) {
      const rows = await prisma.invoice.findMany({ where: { organizationId: ctx.orgId, clientId: clientOf(ctx), status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } }, include: { client: true }, orderBy: { issueDate: 'desc' } });
      return rows.map((inv) => serializeInvoice(inv, { today: today(ctx), portal: true }));
    },

    async invoice(ctx, invoiceId) {
      const inv = await prisma.invoice.findFirst({
        where: { organizationId: ctx.orgId, id: invoiceId, clientId: clientOf(ctx), status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
        include: { client: true, items: true, payments: { orderBy: { createdAt: 'asc' } } },
      });
      if (!inv) throw new NotFoundError('Invoice not found');
      return { invoice: serializeInvoice(inv, { today: today(ctx), portal: true }), client: inv.client, organization: ctx.organization };
    },
  };
}
