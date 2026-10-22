import { amountSchema, currencySchema, emailSchema, idSchema, isoDateSchema, isoDateTimeSchema, quantitySchema, taxRateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { ForbiddenError } from '../../utils/errors.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';

const text = (max) => z.string().trim().min(1).max(max);
const optional = (s) => s.nullable().optional();
const clientFields = {
  name: text(200),
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'Use up to 32 letters, digits, dashes or underscores'),
  industry: optional(text(80)),
  sizeBand: optional(z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+'])),
  website: optional(z.url().max(255)),
  email: optional(emailSchema),
  phone: optional(text(40)),
  address: optional(z.object({ line1: z.string().max(200).optional(), line2: z.string().max(200).optional(), city: z.string().max(100).optional(), region: z.string().max(100).optional(), postalCode: z.string().max(20).optional() }).strict()),
  country: optional(z.string().regex(/^[A-Z]{2}$/, 'Use an ISO country code such as IN')),
  taxId: optional(text(64)),
  accountManagerId: optional(idSchema),
  status: z.enum(['PROSPECT', 'ACTIVE', 'INACTIVE']),
  defaultCurrency: currencySchema,
  paymentTermsDays: z.number().int().min(0).max(365),
};
const createClient = z.object(clientFields).partial().required({ name: true }).strict();
const updateClient = z.object({ ...clientFields, version: z.number().int().min(0) }).partial().strict();
const clientParams = z.object({ clientId: idSchema }).strict();
const listQuery = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['PROSPECT', 'ACTIVE', 'INACTIVE']).optional(), includeArchived: z.enum(['true', 'false']).optional() }).strict();
const contactBody = z.object({ name: text(160), email: optional(emailSchema), phone: optional(text(40)), title: optional(text(120)), isPrimary: z.boolean().optional() }).strict();
const contactParams = z.object({ clientId: idSchema, contactId: idSchema }).strict();
const noteBody = z.object({ kind: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING']).default('NOTE'), body: text(10_000), occurredAt: isoDateTimeSchema.optional() }).strict();
const agreementBody = z
  .object({ name: text(200), startDate: isoDateSchema, endDate: isoDateSchema.nullable(), value: amountSchema.nullable(), currency: currencySchema.nullable(), status: z.enum(['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED']), terms: z.string().max(20_000).nullable() })
  .partial()
  .strict();
const agreementParams = z.object({ clientId: idSchema, agreementId: idSchema }).strict();
const portalBody = z.object({ email: emailSchema, name: text(160) }).strict();
const portalParams = z.object({ clientId: idSchema, memberId: idSchema }).strict();

export function crmRoutes({ crmService, sessionService }) {
  const tags = ['Clients'];
  return defineRoutes('/clients', (r) => {
    r.get('/', { permission: 'clients.read', apiKey: true, query: listQuery, tags, summary: 'Clients (all, or those of projects I manage)' }, async (req, res) => {
      sendOk(res, await crmService.list(req.ctx, { ...req.valid.query, includeArchived: req.valid.query.includeArchived === 'true' }));
    });
    r.post('/', { permission: 'clients.manage', body: createClient, idempotent: true, tags, summary: 'Create a client' }, async (req, res) => {
      sendCreated(res, await crmService.create(req.ctx, req.valid.body));
    });
    r.get('/:clientId', { permission: 'clients.read', apiKey: true, params: clientParams, tags, summary: 'Client with contacts, projects, open tickets and (finance) outstanding' }, async (req, res) => {
      sendOk(res, await crmService.get(req.ctx, req.valid.params.clientId));
    });
    r.patch('/:clientId', { permission: 'clients.manage', params: clientParams, body: updateClient, tags, summary: 'Update a client' }, async (req, res) => {
      sendOk(res, await crmService.update(req.ctx, req.valid.params.clientId, req.valid.body));
    });
    r.post('/:clientId/archive', { permission: 'clients.manage', params: clientParams, tags, summary: 'Archive a client' }, async (req, res) => {
      sendOk(res, await crmService.setArchived(req.ctx, req.valid.params.clientId, true));
    });
    r.post('/:clientId/restore', { permission: 'clients.manage', params: clientParams, tags, summary: 'Restore a client' }, async (req, res) => {
      sendOk(res, await crmService.setArchived(req.ctx, req.valid.params.clientId, false));
    });
    r.post('/:clientId/contacts', { permission: 'clients.manage', params: clientParams, body: contactBody, tags, summary: 'Add a contact' }, async (req, res) => {
      sendCreated(res, await crmService.addContact(req.ctx, req.valid.params.clientId, req.valid.body));
    });
    r.patch('/:clientId/contacts/:contactId', { permission: 'clients.manage', params: contactParams, body: contactBody.partial(), tags, summary: 'Update a contact' }, async (req, res) => {
      sendOk(res, await crmService.updateContact(req.ctx, req.valid.params.clientId, req.valid.params.contactId, req.valid.body));
    });
    r.delete('/:clientId/contacts/:contactId', { permission: 'clients.manage', params: contactParams, tags, summary: 'Remove a contact' }, async (req, res) => {
      await crmService.removeContact(req.ctx, req.valid.params.clientId, req.valid.params.contactId);
      sendNoContent(res);
    });
    r.get('/:clientId/notes', { permission: 'clients.read', params: clientParams, tags, summary: 'Communication history' }, async (req, res) => {
      sendOk(res, await crmService.notes(req.ctx, req.valid.params.clientId));
    });
    r.post('/:clientId/notes', { permission: 'clients.read', params: clientParams, body: noteBody, tags, summary: 'Log a note, call, email or meeting' }, async (req, res) => {
      sendCreated(res, await crmService.addNote(req.ctx, req.valid.params.clientId, req.valid.body));
    });
    r.get('/:clientId/agreements', { permission: 'clients.read', params: clientParams, tags, summary: 'Service agreements' }, async (req, res) => {
      sendOk(res, await crmService.agreements(req.ctx, req.valid.params.clientId));
    });
    r.post('/:clientId/agreements', { permission: 'clients.manage', params: clientParams, body: agreementBody.required({ name: true, startDate: true }), tags, summary: 'Add a service agreement' }, async (req, res) => {
      sendCreated(res, await crmService.saveAgreement(req.ctx, req.valid.params.clientId, null, req.valid.body));
    });
    r.patch('/:clientId/agreements/:agreementId', { permission: 'clients.manage', params: agreementParams, body: agreementBody, tags, summary: 'Update a service agreement' }, async (req, res) => {
      sendOk(res, await crmService.saveAgreement(req.ctx, req.valid.params.clientId, req.valid.params.agreementId, req.valid.body));
    });
    r.get('/:clientId/portal-users', { permission: 'clients.manage', params: clientParams, tags, summary: 'Client portal users' }, async (req, res) => {
      sendOk(res, await crmService.portalUsers(req.ctx, req.valid.params.clientId));
    });
    r.post('/:clientId/portal-users', { permission: 'clients.manage', params: clientParams, body: portalBody, idempotent: true, tags, summary: 'Invite a client contact to the portal' }, async (req, res) => {
      sendCreated(res, await crmService.invitePortalUser(req.ctx, req.valid.params.clientId, req.valid.body));
    });
    r.post('/:clientId/portal-users/:memberId/revoke', { permission: 'clients.manage', params: portalParams, tags, summary: 'Remove portal access (signs the user out)' }, async (req, res) => {
      await crmService.revokePortalUser(req.ctx, req.valid.params.clientId, req.valid.params.memberId, sessionService);
      sendNoContent(res);
    });
  });
}

const leadFields = {
  name: text(160),
  company: optional(text(200)),
  email: optional(emailSchema),
  phone: optional(text(40)),
  source: optional(text(48)),
  ownerId: optional(idSchema),
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'LOST']),
  score: optional(z.number().int().min(0).max(100)),
  followUpAt: optional(isoDateTimeSchema),
  lostReason: optional(text(500)),
  notes: optional(z.string().max(10_000)),
  estimatedValue: optional(amountSchema),
  currency: optional(currencySchema),
};
const leadParams = z.object({ leadId: idSchema }).strict();
const statusList = z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST'])));
const leadQuery = z.object({ status: statusList.optional(), ownerId: idSchema.optional(), q: z.string().trim().max(100).optional() }).strict();
const convertBody = z
  .object({ clientId: idSchema.optional(), clientName: text(200).optional(), createOpportunity: z.boolean().default(true), opportunityName: text(200).optional(), value: amountSchema.optional(), currency: currencySchema.optional() })
  .strict();
const stageBody = z.object({ name: text(80), defaultProbability: z.number().int().min(0).max(100), isWon: z.boolean(), isLost: z.boolean(), sortOrder: z.number().int().min(0), archivedAt: z.null() }).partial().strict();
const stageParams = z.object({ stageId: idSchema }).strict();
const oppFields = {
  name: text(200),
  clientId: optional(idSchema),
  stageId: idSchema,
  value: amountSchema,
  currency: currencySchema,
  probability: z.number().int().min(0).max(100),
  expectedCloseDate: optional(isoDateSchema),
  ownerId: optional(idSchema),
  lostReason: optional(text(500)),
};
const oppParams = z.object({ opportunityId: idSchema }).strict();
const oppQuery = z.object({ stageId: idSchema.optional(), clientId: idSchema.optional(), ownerId: idSchema.optional(), open: z.enum(['true', 'false']).optional() }).strict();
const pipelineQuery = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() }).strict();
const activityQuery = z.object({ subjectType: z.enum(['LEAD', 'OPPORTUNITY', 'CLIENT']).optional(), subjectId: idSchema.optional(), mine: z.enum(['true', 'false']).optional() }).strict();
const activityBody = z.object({ subjectType: z.enum(['LEAD', 'OPPORTUNITY', 'CLIENT']), subjectId: idSchema, kind: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING']), title: text(200), dueAt: isoDateTimeSchema.optional(), ownerId: idSchema.optional() }).strict();
const activityParams = z.object({ activityId: idSchema }).strict();
const quoteItem = z.object({ description: text(500), quantity: quantitySchema, unitPrice: amountSchema, taxRate: taxRateSchema.default('0') }).strict();
const quoteCreate = z
  .object({ clientId: idSchema, opportunityId: idSchema.optional(), title: text(200), currency: currencySchema.optional(), validUntil: isoDateSchema.optional(), notes: z.string().max(10_000).optional(), items: z.array(quoteItem).max(200).default([]) })
  .strict();
const quoteUpdate = z.object({ title: text(200), validUntil: isoDateSchema.nullable(), notes: z.string().max(10_000).nullable(), items: z.array(quoteItem).max(200) }).partial().strict();
const quoteParams = z.object({ quoteId: idSchema }).strict();
const quoteQuery = z.object({ clientId: idSchema.optional(), status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED']).optional() }).strict();

/** Sales activities belong to leads or opportunities: either permission may use them. */
function assertSales(ctx) {
  if (!hasPermission(ctx, 'leads.manage') && !hasPermission(ctx, 'opportunities.manage')) throw new ForbiddenError();
}

export function salesRoutes({ salesService }) {
  const tags = ['Sales'];
  return defineRoutes('', (r) => {
    r.get('/leads', { permission: 'leads.manage', query: leadQuery, tags, summary: 'Leads' }, async (req, res) => {
      sendOk(res, await salesService.listLeads(req.ctx, req.valid.query));
    });
    r.post('/leads', { permission: 'leads.manage', body: z.object(leadFields).partial().required({ name: true }).strict(), idempotent: true, tags, summary: 'Create a lead' }, async (req, res) => {
      sendCreated(res, await salesService.createLead(req.ctx, req.valid.body));
    });
    r.patch('/leads/:leadId', { permission: 'leads.manage', params: leadParams, body: z.object({ ...leadFields, version: z.number().int().min(0) }).partial().strict(), tags, summary: 'Update a lead (status changes follow the lead workflow)' }, async (req, res) => {
      sendOk(res, await salesService.updateLead(req.ctx, req.valid.params.leadId, req.valid.body));
    });
    r.post('/leads/:leadId/convert', { permission: 'leads.manage', params: leadParams, body: convertBody, idempotent: true, tags, summary: 'Convert to client + contact (+ opportunity) in one step' }, async (req, res) => {
      sendCreated(res, await salesService.convertLead(req.ctx, req.valid.params.leadId, req.valid.body));
    });

    r.get('/pipeline-stages', { permission: 'opportunities.manage', tags, summary: 'Pipeline stages' }, async (req, res) => {
      sendOk(res, await salesService.stages(req.ctx));
    });
    r.post('/pipeline-stages', { permission: 'opportunities.manage', body: stageBody.required({ name: true, defaultProbability: true }), tags, summary: 'Add a stage' }, async (req, res) => {
      sendCreated(res, await salesService.saveStage(req.ctx, null, req.valid.body));
    });
    r.patch('/pipeline-stages/:stageId', { permission: 'opportunities.manage', params: stageParams, body: stageBody, tags, summary: 'Update a stage' }, async (req, res) => {
      sendOk(res, await salesService.saveStage(req.ctx, req.valid.params.stageId, req.valid.body));
    });
    r.get('/opportunities', { permission: 'opportunities.manage', query: oppQuery, tags, summary: 'Opportunities' }, async (req, res) => {
      sendOk(res, await salesService.listOpportunities(req.ctx, { ...req.valid.query, open: req.valid.query.open === 'true' }));
    });
    r.post('/opportunities', { permission: 'opportunities.manage', body: z.object(oppFields).partial().required({ name: true, value: true, currency: true }).strict(), idempotent: true, tags, summary: 'Create an opportunity' }, async (req, res) => {
      sendCreated(res, await salesService.saveOpportunity(req.ctx, null, req.valid.body));
    });
    r.patch('/opportunities/:opportunityId', { permission: 'opportunities.manage', params: oppParams, body: z.object({ ...oppFields, version: z.number().int().min(0) }).partial().strict(), tags, summary: 'Update or move an opportunity' }, async (req, res) => {
      sendOk(res, await salesService.saveOpportunity(req.ctx, req.valid.params.opportunityId, req.valid.body));
    });
    r.get('/pipeline', { permission: 'opportunities.manage', query: pipelineQuery, tags, summary: 'Pipeline value (measured) and weighted forecast (estimated) in the base currency' }, async (req, res) => {
      sendOk(res, await salesService.pipeline(req.ctx, req.valid.query));
    });

    r.get('/sales-activities', { permission: MEMBER, query: activityQuery, tags, summary: 'Follow-ups for a lead, opportunity or client (or mine)' }, async (req, res) => {
      assertSales(req.ctx);
      sendOk(res, await salesService.activities(req.ctx, { ...req.valid.query, mine: req.valid.query.mine === 'true' }));
    });
    r.post('/sales-activities', { permission: MEMBER, body: activityBody, tags, summary: 'Schedule a follow-up' }, async (req, res) => {
      assertSales(req.ctx);
      sendCreated(res, await salesService.addActivity(req.ctx, req.valid.body));
    });
    r.post('/sales-activities/:activityId/done', { permission: MEMBER, params: activityParams, body: z.object({ done: z.boolean() }).strict(), tags, summary: 'Mark a follow-up done (or not)' }, async (req, res) => {
      assertSales(req.ctx);
      await salesService.completeActivity(req.ctx, req.valid.params.activityId, req.valid.body.done);
      sendNoContent(res);
    });

    r.get('/quotes', { permission: 'quotes.manage', query: quoteQuery, tags, summary: 'Quotes (latest versions)' }, async (req, res) => {
      sendOk(res, await salesService.listQuotes(req.ctx, req.valid.query));
    });
    r.post('/quotes', { permission: 'quotes.manage', body: quoteCreate, idempotent: true, tags, summary: 'Create a quote' }, async (req, res) => {
      sendCreated(res, await salesService.createQuote(req.ctx, req.valid.body));
    });
    r.get('/quotes/:quoteId', { permission: 'quotes.manage', params: quoteParams, tags, summary: 'Quote with lines' }, async (req, res) => {
      sendOk(res, await salesService.getQuote(req.ctx, req.valid.params.quoteId));
    });
    r.patch('/quotes/:quoteId', { permission: 'quotes.manage', params: quoteParams, body: quoteUpdate, tags, summary: 'Edit a draft quote' }, async (req, res) => {
      sendOk(res, await salesService.updateQuote(req.ctx, req.valid.params.quoteId, req.valid.body));
    });
    for (const action of ['send', 'accept', 'decline']) {
      r.post(`/quotes/:quoteId/${action}`, { permission: 'quotes.manage', params: quoteParams, tags, summary: `Mark a quote ${action === 'send' ? 'sent' : `${action}ed`}` }, async (req, res) => {
        sendOk(res, await salesService.transitionQuote(req.ctx, req.valid.params.quoteId, action));
      });
    }
    r.post('/quotes/:quoteId/revise', { permission: 'quotes.manage', params: quoteParams, tags, summary: 'Revise a sent or declined quote as a new version' }, async (req, res) => {
      sendCreated(res, await salesService.reviseQuote(req.ctx, req.valid.params.quoteId));
    });
  });
}
