import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope, hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { sendInvitation } from '../employees/employees.service.js';
import { moneyString } from '../finance/money.js';
import { isoDate } from '../../utils/time.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

function codeFromName(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const base = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'CLI').slice(0, 5);
  return base.slice(0, 8) || 'CLI';
}

/**
 * Which clients the caller may read: all (clients.read@org), or those of projects they manage
 * (clients.read@project). Returns a Prisma where-clause.
 */
export async function readableClientsWhere(db, ctx) {
  if (hasOrgScope(ctx, 'clients.read')) return { organizationId: ctx.orgId };
  if (!hasPermission(ctx, 'clients.read')) return { organizationId: ctx.orgId, id: '__none__' };
  const projects = await db.project.findMany({
    where: { organizationId: ctx.orgId, clientId: { not: null }, OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId, role: 'MANAGER' } } }] },
    select: { clientId: true },
  });
  return { organizationId: ctx.orgId, id: { in: [...new Set(projects.map((p) => p.clientId))] } };
}

export async function loadReadableClient(db, ctx, clientId) {
  const where = await readableClientsWhere(db, ctx);
  const client = await db.client.findFirst({ where: { AND: [where, { id: clientId }] } });
  if (!client) throw new NotFoundError('Client not found');
  return client;
}

const serializeContact = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, title: c.title, isPrimary: c.isPrimary });

export function createCrmService({ prisma, clock, cipher, env }) {
  async function serializeClient(db, ctx, c, { detail = false } = {}) {
    const people = await memberSummaries(db, ctx.orgId, [c.accountManagerId]);
    const base = {
      id: c.id,
      code: c.code,
      name: c.name,
      industry: c.industry,
      sizeBand: c.sizeBand,
      website: c.website,
      email: c.email,
      phone: c.phone,
      address: c.address,
      country: c.country,
      taxId: c.taxId,
      status: c.status,
      defaultCurrency: c.defaultCurrency,
      paymentTermsDays: c.paymentTermsDays,
      accountManager: c.accountManagerId && people.get(c.accountManagerId) ? { id: people.get(c.accountManagerId).employeeId, name: people.get(c.accountManagerId).name } : null,
      archivedAt: c.archivedAt,
      version: c.version,
      createdAt: c.createdAt,
    };
    if (!detail) return base;
    const canFinance = hasPermission(ctx, 'finance.invoices.read');
    const [contacts, projects, openTickets, outstanding] = await Promise.all([
      db.clientContact.findMany({ where: { organizationId: ctx.orgId, clientId: c.id, archivedAt: null }, orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] }),
      db.project.findMany({ where: { organizationId: ctx.orgId, clientId: c.id, archivedAt: null }, select: { id: true, code: true, name: true, status: true, sharedWithClient: true } }),
      db.supportTicket.count({ where: { organizationId: ctx.orgId, clientId: c.id, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT'] } } }),
      canFinance ? db.invoice.findMany({ where: { organizationId: ctx.orgId, clientId: c.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, select: { total: true, amountPaid: true, currency: true } }) : null,
    ]);
    const owed = new Map();
    for (const inv of outstanding ?? []) owed.set(inv.currency, (owed.get(inv.currency) ?? inv.total.minus(inv.total)).plus(inv.total.minus(inv.amountPaid)));
    return {
      ...base,
      contacts: contacts.map(serializeContact),
      projects,
      openTickets,
      ...(canFinance ? { outstanding: [...owed].map(([currency, amount]) => ({ currency, amount: moneyString(amount, currency) })) } : {}),
      canManage: hasPermission(ctx, 'clients.manage'),
    };
  }

  async function uniqueCode(db, organizationId, desired) {
    for (let n = 1; n < 100; n += 1) {
      const code = n === 1 ? desired : `${desired}${n}`;
      if (!(await db.client.findFirst({ where: { organizationId, code } }))) return code;
    }
    throw new ConflictError('Could not generate a unique client code; choose one');
  }

  async function managerId(db, ctx, employeeId) {
    if (employeeId === undefined) return undefined;
    return employeeId ? resolveEmployeeUserId(db, ctx.orgId, employeeId, 'body.accountManagerId') : null;
  }

  async function loadManagedClient(db, ctx, clientId) {
    const client = await db.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } });
    if (!client) throw new NotFoundError('Client not found');
    return client;
  }

  const service = {
    async list(ctx, { q, status, includeArchived }) {
      const where = await readableClientsWhere(prisma, ctx);
      const filters = [where];
      if (!includeArchived) filters.push({ archivedAt: null });
      if (status) filters.push({ status });
      if (q) filters.push({ OR: [{ name: { contains: q } }, { code: { contains: q } }, { email: { contains: q } }] });
      const rows = await prisma.client.findMany({ where: { AND: filters }, orderBy: { name: 'asc' }, take: 500 });
      return Promise.all(rows.map((c) => serializeClient(prisma, ctx, c)));
    },

    async get(ctx, clientId) {
      return serializeClient(prisma, ctx, await loadReadableClient(prisma, ctx, clientId), { detail: true });
    },

    async create(ctx, body) {
      return withTransaction(prisma, async (tx) => {
        const code = body.code ? body.code.toUpperCase() : await uniqueCode(tx, ctx.orgId, codeFromName(body.name));
        if (body.code && (await tx.client.findFirst({ where: { organizationId: ctx.orgId, code } }))) {
          throw new ConflictError('Another client already uses this code', ERROR_CODES.CONFLICT, [{ path: 'body.code', message: 'Already in use' }]);
        }
        const { accountManagerId, ...rest } = body;
        const client = await tx.client.create({
          data: {
            ...rest,
            code,
            organizationId: ctx.orgId,
            defaultCurrency: body.defaultCurrency ?? ctx.organization?.baseCurrency ?? 'USD',
            accountManagerId: (await managerId(tx, ctx, accountManagerId)) ?? null,
          },
        });
        await recordAudit(tx, ctx, { action: 'clients.created', targetType: 'client', targetId: client.id, diff: { code, name: client.name } });
        await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'client.created', data: { clientId: client.id, code, name: client.name } });
        return serializeClient(tx, ctx, client, { detail: true });
      });
    },

    async update(ctx, clientId, { version, accountManagerId, ...patch }) {
      return withTransaction(prisma, async (tx) => {
        const client = await loadManagedClient(tx, ctx, clientId);
        if (version !== undefined && version !== client.version) throw new ConflictError('This client changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        if (patch.code) {
          patch.code = patch.code.toUpperCase();
          if (await tx.client.findFirst({ where: { organizationId: ctx.orgId, code: patch.code, id: { not: client.id } } })) throw new ConflictError('Another client already uses this code');
        }
        const manager = await managerId(tx, ctx, accountManagerId);
        const updated = await tx.client.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: client.id } },
          data: { ...patch, ...(manager !== undefined ? { accountManagerId: manager } : {}), version: { increment: 1 } },
        });
        await recordAudit(tx, ctx, { action: 'clients.updated', targetType: 'client', targetId: client.id, diff: { changed: Object.keys(patch) } });
        return serializeClient(tx, ctx, updated, { detail: true });
      });
    },

    async setArchived(ctx, clientId, archived) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      const updated = await prisma.client.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: client.id } }, data: { archivedAt: archived ? clock.now() : null, version: { increment: 1 } } });
      await recordAudit(prisma, ctx, { action: archived ? 'clients.archived' : 'clients.restored', targetType: 'client', targetId: client.id });
      return serializeClient(prisma, ctx, updated);
    },

    // ─── contacts & communications ──────────────────────────────────────────

    async addContact(ctx, clientId, body) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      return withTransaction(prisma, async (tx) => {
        if (body.isPrimary) await tx.clientContact.updateMany({ where: { organizationId: ctx.orgId, clientId: client.id }, data: { isPrimary: false } });
        return serializeContact(await tx.clientContact.create({ data: { organizationId: ctx.orgId, clientId: client.id, ...body } }));
      });
    },

    async updateContact(ctx, clientId, contactId, body) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      return withTransaction(prisma, async (tx) => {
        const contact = await tx.clientContact.findFirst({ where: { organizationId: ctx.orgId, clientId: client.id, id: contactId, archivedAt: null } });
        if (!contact) throw new NotFoundError('Contact not found');
        if (body.isPrimary) await tx.clientContact.updateMany({ where: { organizationId: ctx.orgId, clientId: client.id }, data: { isPrimary: false } });
        return serializeContact(await tx.clientContact.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: contact.id } }, data: body }));
      });
    },

    async removeContact(ctx, clientId, contactId) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      const { count } = await prisma.clientContact.updateMany({
        where: { organizationId: ctx.orgId, clientId: client.id, id: contactId, archivedAt: null },
        data: { archivedAt: clock.now(), isPrimary: false },
      });
      if (!count) throw new NotFoundError('Contact not found');
    },

    async notes(ctx, clientId) {
      const client = await loadReadableClient(prisma, ctx, clientId);
      const rows = await prisma.clientNote.findMany({ where: { organizationId: ctx.orgId, clientId: client.id }, orderBy: { occurredAt: 'desc' }, take: 200 });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.authorId));
      return rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, occurredAt: r.occurredAt, author: { name: people.get(r.authorId)?.name ?? 'Former member' } }));
    },

    /** Anyone who can read the client may log a communication with it. */
    async addNote(ctx, clientId, { kind, body, occurredAt }) {
      const client = await loadReadableClient(prisma, ctx, clientId);
      const note = await prisma.clientNote.create({
        data: { organizationId: ctx.orgId, clientId: client.id, kind, body, occurredAt: occurredAt ? new Date(occurredAt) : clock.now(), authorId: ctx.userId },
      });
      return { id: note.id, kind: note.kind, body: note.body, occurredAt: note.occurredAt, author: { name: ctx.user.name } };
    },

    // ─── service agreements ─────────────────────────────────────────────────

    async agreements(ctx, clientId) {
      const client = await loadReadableClient(prisma, ctx, clientId);
      const rows = await prisma.serviceAgreement.findMany({ where: { organizationId: ctx.orgId, clientId: client.id }, orderBy: { startDate: 'desc' } });
      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        startDate: isoDate(a.startDate),
        endDate: a.endDate ? isoDate(a.endDate) : null,
        value: a.value ? moneyString(a.value, a.currency) : null,
        currency: a.currency,
        status: a.status,
        terms: a.terms,
      }));
    },

    async saveAgreement(ctx, clientId, agreementId, body) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      if (body.endDate && body.startDate && body.endDate < body.startDate) throw new ValidationError([{ path: 'body.endDate', message: 'The end date must be after the start date' }]);
      if (body.value !== undefined && body.value !== null && !body.currency) throw new ValidationError([{ path: 'body.currency', message: 'A value needs a currency' }]);
      const data = {
        ...body,
        ...(body.startDate ? { startDate: new Date(`${body.startDate}T00:00:00Z`) } : {}),
        ...(body.endDate !== undefined ? { endDate: body.endDate ? new Date(`${body.endDate}T00:00:00Z`) : null } : {}),
      };
      let row;
      if (agreementId) {
        const existing = await prisma.serviceAgreement.findFirst({ where: { organizationId: ctx.orgId, clientId: client.id, id: agreementId } });
        if (!existing) throw new NotFoundError('Agreement not found');
        row = await prisma.serviceAgreement.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: agreementId } }, data });
      } else {
        row = await prisma.serviceAgreement.create({ data: { organizationId: ctx.orgId, clientId: client.id, ...data } });
      }
      await recordAudit(prisma, ctx, { action: agreementId ? 'clients.agreement_updated' : 'clients.agreement_created', targetType: 'service_agreement', targetId: row.id });
      return (await service.agreements(ctx, client.id)).find((a) => a.id === row.id);
    },

    // ─── client portal users ────────────────────────────────────────────────

    async portalUsers(ctx, clientId) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      const members = await prisma.organizationMember.findMany({
        where: { organizationId: ctx.orgId, clientId: client.id, memberType: 'CLIENT' },
        include: { user: { select: { name: true, email: true } } },
      });
      return members.map((m) => ({ id: m.id, name: m.user.name, email: m.user.email, status: m.status, joinedAt: m.joinedAt }));
    },

    /** Invites a client contact to the portal: a CLIENT member bound to this client only. */
    async invitePortalUser(ctx, clientId, { email, name }) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      if (client.archivedAt) throw new BusinessRuleError('Restore the client before inviting portal users');
      return withTransaction(prisma, async (tx) => {
        const user = (await tx.user.findUnique({ where: { email } })) ?? (await tx.user.create({ data: { email, name } }));
        const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: user.id } } });
        const reinvite = existing?.memberType === 'CLIENT' && existing.clientId === client.id && ['DEACTIVATED', 'ARCHIVED'].includes(existing.status);
        if (existing && !reinvite) throw new ConflictError('This person is already a member of the organization');
        const member = existing
          ? await tx.organizationMember.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: user.id } }, data: { status: 'INVITED', deactivatedAt: null } })
          : await tx.organizationMember.create({ data: { organizationId: ctx.orgId, userId: user.id, memberType: 'CLIENT', clientId: client.id, status: 'INVITED' } });
        const role = await tx.role.findFirst({ where: { organizationId: ctx.orgId, key: 'CLIENT_USER' } });
        await tx.memberRole.deleteMany({ where: { organizationId: ctx.orgId, userId: user.id } });
        await tx.memberRole.create({ data: { organizationId: ctx.orgId, userId: user.id, roleId: role.id } });
        await sendInvitation(tx, ctx, { member, email: user.email, name, organizationName: ctx.organization.name, send: true }, { clock, cipher, env });
        await recordAudit(tx, ctx, { action: 'clients.portal_user_invited', targetType: 'client', targetId: client.id, diff: { email } });
        return { id: member.id, name: user.name, email: user.email, status: 'INVITED' };
      });
    },

    async revokePortalUser(ctx, clientId, memberId, sessionService) {
      const client = await loadManagedClient(prisma, ctx, clientId);
      await withTransaction(prisma, async (tx) => {
        const member = await tx.organizationMember.findFirst({ where: { organizationId: ctx.orgId, id: memberId, clientId: client.id, memberType: 'CLIENT' } });
        if (!member) throw new NotFoundError('Portal user not found');
        if (member.userId === ctx.userId) throw new ForbiddenError();
        await tx.organizationMember.update({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: member.userId } }, data: { status: 'DEACTIVATED', deactivatedAt: clock.now() } });
        await sessionService.revoke(tx, { userId: member.userId, activeOrganizationId: ctx.orgId }, 'portal_access_revoked');
        await tx.invitation.updateMany({ where: { organizationId: ctx.orgId, userId: member.userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: clock.now() } });
        await recordAudit(tx, ctx, { action: 'clients.portal_user_revoked', targetType: 'client', targetId: client.id, diff: { memberId } });
      });
    },
  };
  return service;
}
