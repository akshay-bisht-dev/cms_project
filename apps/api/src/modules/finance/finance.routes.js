import { amountSchema, currencySchema, idSchema, isoDateSchema, quantitySchema, signedAmountSchema, taxRateSchema, z } from '@orbit/validation';
import { defineRoutes } from '../../routes/define-routes.js';
import { MEMBER } from '../../middleware/authorize.js';
import { ForbiddenError } from '../../utils/errors.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { sendCreated, sendNoContent, sendOk } from '../../utils/response.js';
import { invoicePdf } from './invoice-pdf.js';

const text = (max) => z.string().trim().min(1).max(max);
const rateBody = z
  .object({
    kind: z.enum(['BILL', 'COST']),
    targetType: z.enum(['ORG', 'MEMBER', 'CLIENT', 'PROJECT', 'PROJECT_MEMBER']),
    targetId: idSchema.optional(),
    projectId: idSchema.optional(),
    amount: amountSchema,
    currency: currencySchema,
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.optional(),
  })
  .strict()
  .refine((b) => b.targetType === 'ORG' || b.targetId, { path: ['targetId'], message: 'Choose who or what the rate applies to' });
const rateParams = z.object({ rateId: idSchema }).strict();
const fxBody = z.object({ currency: currencySchema, rateToBase: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, 'Use a rate such as 0.92345678'), effectiveFrom: isoDateSchema }).strict();
const categoryParams = z.object({ categoryId: idSchema }).strict();
const expenseFields = {
  description: text(500),
  amount: amountSchema,
  currency: currencySchema,
  incurredOn: isoDateSchema,
  isBillable: z.boolean(),
  projectId: idSchema.nullable(),
  clientId: idSchema.nullable(),
  categoryId: idSchema.nullable(),
  receiptFileId: idSchema.nullable(),
};
const expenseParams = z.object({ expenseId: idSchema }).strict();
const list = (schema) => z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(schema));
const expenseQuery = z
  .object({ view: z.enum(['mine', 'approvals', 'all']).default('mine'), status: list(z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED'])).optional(), projectId: idSchema.optional(), clientId: idSchema.optional() })
  .strict();
const receiptBody = z.object({ fileName: text(255), contentType: z.string().max(127), sizeBytes: z.number().int().min(1) }).strict();
const lineBody = z.object({ description: text(500), quantity: quantitySchema, unitPrice: amountSchema, taxRate: taxRateSchema.default('0') }).strict();
const invoiceParams = z.object({ invoiceId: idSchema }).strict();
const itemParams = z.object({ invoiceId: idSchema, itemId: idSchema }).strict();
const invoiceQuery = z
  .object({ status: list(z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'])).optional(), clientId: idSchema.optional(), projectId: idSchema.optional(), overdue: z.enum(['true', 'false']).optional() })
  .strict();
const createInvoice = z.object({ clientId: idSchema, projectId: idSchema.optional(), currency: currencySchema.optional(), dueDate: isoDateSchema.optional(), notes: z.string().max(5000).optional(), items: z.array(lineBody).max(200).default([]) }).strict();
const updateInvoice = z.object({ notes: z.string().max(5000).nullable(), dueDate: isoDateSchema.nullable(), version: z.number().int().min(0) }).partial().strict();
const range = { from: isoDateSchema, to: isoDateSchema };
const previewQuery = z.object({ clientId: idSchema, projectId: idSchema.optional(), currency: currencySchema.optional(), groupBy: z.enum(['member', 'project', 'entry']).default('member'), ...range }).strict();
const addTimeBody = z.object({ projectId: idSchema.optional(), groupBy: z.enum(['member', 'project', 'entry']).default('member'), taxRate: taxRateSchema.default('0'), ...range }).strict();
const addExpensesBody = z.object({ expenseIds: z.array(idSchema).min(1).max(200), taxRate: taxRateSchema.default('0') }).strict();
const issueBody = z.object({ issueDate: isoDateSchema.optional(), dueDate: isoDateSchema.optional() }).strict();
const paymentBody = z
  .object({ amount: signedAmountSchema, receivedOn: isoDateSchema, method: z.enum(['BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE', 'OTHER']), reference: text(120).optional(), note: text(500).optional() })
  .strict();

export function financeRoutes({ rateService, expenseService, invoiceService }) {
  const tags = ['Finance'];
  return defineRoutes('', (r) => {
    // ─── rates ──────────────────────────────────────────────────────────────
    r.get('/billing-rates', { permission: 'finance.rates.manage', query: z.object({ kind: z.enum(['BILL', 'COST']).optional() }).strict(), tags, summary: 'Billing rates (cost rates need finance.cost.read)' }, async (req, res) => {
      sendOk(res, await rateService.listRates(req.ctx, req.valid.query));
    });
    r.post('/billing-rates', { permission: 'finance.rates.manage', body: rateBody, tags, summary: 'Add a rate (periods may not overlap)' }, async (req, res) => {
      sendCreated(res, await rateService.createRate(req.ctx, req.valid.body));
    });
    r.post('/billing-rates/:rateId/end', { permission: 'finance.rates.manage', params: rateParams, body: z.object({ effectiveTo: isoDateSchema }).strict(), tags, summary: 'End a rate on a date' }, async (req, res) => {
      await rateService.endRate(req.ctx, req.valid.params.rateId, req.valid.body);
      sendNoContent(res);
    });
    r.get('/exchange-rates', { permission: 'finance.rates.manage', tags, summary: 'Exchange rates to the base currency' }, async (req, res) => {
      sendOk(res, await rateService.exchangeRates(req.ctx));
    });
    r.post('/exchange-rates', { permission: 'finance.rates.manage', body: fxBody, tags, summary: 'Add an exchange rate' }, async (req, res) => {
      sendCreated(res, await rateService.addExchangeRate(req.ctx, req.valid.body));
    });
    // Everyone who submits expenses needs the categories.
    r.get('/expense-categories', { permission: 'finance.expenses.submit', tags, summary: 'Expense categories' }, async (req, res) => {
      sendOk(res, await rateService.categories(req.ctx));
    });
    r.post('/expense-categories', { permission: 'finance.rates.manage', body: z.object({ name: text(80) }).strict(), tags, summary: 'Add a category' }, async (req, res) => {
      sendCreated(res, await rateService.saveCategory(req.ctx, null, req.valid.body));
    });
    r.patch('/expense-categories/:categoryId', { permission: 'finance.rates.manage', params: categoryParams, body: z.object({ name: text(80), archived: z.boolean() }).partial().strict(), tags, summary: 'Rename or archive a category' }, async (req, res) => {
      sendOk(res, await rateService.saveCategory(req.ctx, req.valid.params.categoryId, req.valid.body));
    });

    // ─── expenses ───────────────────────────────────────────────────────────
    r.get('/expenses', { permission: MEMBER, query: expenseQuery, tags, summary: 'My expenses, those awaiting my approval, or all (finance)' }, async (req, res) => {
      const { view } = req.valid.query;
      const need = { mine: 'finance.expenses.submit', approvals: 'finance.expenses.approve', all: 'finance.invoices.manage' }[view];
      if (!hasPermission(req.ctx, need)) throw new ForbiddenError();
      sendOk(res, await expenseService.list(req.ctx, req.valid.query));
    });
    r.post('/expenses/receipts', { permission: 'finance.expenses.submit', body: receiptBody, tags, summary: 'Signed upload for a receipt (PDF or image, ≤ 10 MB)' }, async (req, res) => {
      sendCreated(res, await expenseService.presignReceipt(req.ctx, req.valid.body));
    });
    r.post('/expenses/receipts/:fileId/confirm', { permission: 'finance.expenses.submit', params: z.object({ fileId: idSchema }).strict(), tags, summary: 'Confirm an uploaded receipt' }, async (req, res) => {
      sendOk(res, await expenseService.confirmReceipt(req.ctx, req.valid.params.fileId));
    });
    r.post('/expenses', { permission: 'finance.expenses.submit', body: z.object(expenseFields).partial().required({ description: true, amount: true, currency: true, incurredOn: true }).strict(), tags, summary: 'Record an expense (draft)' }, async (req, res) => {
      sendCreated(res, await expenseService.create(req.ctx, req.valid.body));
    });
    r.patch('/expenses/:expenseId', { permission: 'finance.expenses.submit', params: expenseParams, body: z.object({ ...expenseFields, version: z.number().int().min(0) }).partial().strict(), tags, summary: 'Edit my draft or rejected expense' }, async (req, res) => {
      sendOk(res, await expenseService.update(req.ctx, req.valid.params.expenseId, req.valid.body));
    });
    r.delete('/expenses/:expenseId', { permission: 'finance.expenses.submit', params: expenseParams, tags, summary: 'Delete my draft expense' }, async (req, res) => {
      await expenseService.remove(req.ctx, req.valid.params.expenseId);
      sendNoContent(res);
    });
    r.post('/expenses/:expenseId/submit', { permission: 'finance.expenses.submit', params: expenseParams, tags, summary: 'Submit for approval' }, async (req, res) => {
      sendOk(res, await expenseService.submit(req.ctx, req.valid.params.expenseId));
    });
    r.post('/expenses/:expenseId/decide', { permission: 'finance.expenses.approve', params: expenseParams, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: text(500).optional() }).strict(), tags, summary: 'Approve or reject (not my own)' }, async (req, res) => {
      sendOk(res, await expenseService.decide(req.ctx, req.valid.params.expenseId, req.valid.body));
    });
    r.post('/expenses/:expenseId/reimburse', { permission: 'finance.payments.record', params: expenseParams, tags, summary: 'Mark an approved expense reimbursed' }, async (req, res) => {
      await expenseService.reimburse(req.ctx, req.valid.params.expenseId);
      sendNoContent(res);
    });
    r.get('/expenses/:expenseId/receipt', { permission: MEMBER, params: expenseParams, tags, summary: 'Receipt link (owner, approvers, finance)' }, async (req, res) => {
      sendOk(res, await expenseService.receiptUrl(req.ctx, req.valid.params.expenseId));
    });

    // ─── invoices ───────────────────────────────────────────────────────────
    r.get('/invoices', { permission: 'finance.invoices.read', apiKey: true, query: invoiceQuery, tags, summary: 'Invoices' }, async (req, res) => {
      sendOk(res, await invoiceService.list(req.ctx, { ...req.valid.query, overdue: req.valid.query.overdue === 'true' }));
    });
    r.post('/invoices', { permission: 'finance.invoices.manage', body: createInvoice, idempotent: true, tags, summary: 'Create a draft invoice' }, async (req, res) => {
      sendCreated(res, await invoiceService.createDraft(req.ctx, req.valid.body));
    });
    r.get('/invoices/billable-time', { permission: 'finance.invoices.manage', query: previewQuery, tags, summary: 'Preview approved billable time not yet invoiced, priced' }, async (req, res) => {
      sendOk(res, await invoiceService.previewTime(req.ctx, req.valid.query));
    });
    r.get('/invoices/:invoiceId', { permission: 'finance.invoices.read', apiKey: true, params: invoiceParams, tags, summary: 'Invoice with lines and payments' }, async (req, res) => {
      sendOk(res, await invoiceService.get(req.ctx, req.valid.params.invoiceId));
    });
    r.get('/invoices/:invoiceId/pdf', { permission: 'finance.invoices.read', params: invoiceParams, tags, summary: 'Invoice PDF' }, async (req, res) => {
      const data = await invoiceService.pdfData(req.ctx, req.valid.params.invoiceId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${data.invoice.number ?? 'draft-invoice'}.pdf"`);
      res.send(await invoicePdf(data));
    });
    r.patch('/invoices/:invoiceId', { permission: 'finance.invoices.manage', params: invoiceParams, body: updateInvoice, tags, summary: 'Edit a draft' }, async (req, res) => {
      sendOk(res, await invoiceService.updateDraft(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.delete('/invoices/:invoiceId', { permission: 'finance.invoices.manage', params: invoiceParams, tags, summary: 'Delete a draft (frees its time and expenses)' }, async (req, res) => {
      await invoiceService.deleteDraft(req.ctx, req.valid.params.invoiceId);
      sendNoContent(res);
    });
    r.post('/invoices/:invoiceId/items', { permission: 'finance.invoices.manage', params: invoiceParams, body: lineBody, tags, summary: 'Add a manual line' }, async (req, res) => {
      sendCreated(res, await invoiceService.addManualItem(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.delete('/invoices/:invoiceId/items/:itemId', { permission: 'finance.invoices.manage', params: itemParams, tags, summary: 'Remove a line' }, async (req, res) => {
      sendOk(res, await invoiceService.removeItem(req.ctx, req.valid.params.invoiceId, req.valid.params.itemId));
    });
    r.post('/invoices/:invoiceId/time', { permission: 'finance.invoices.manage', params: invoiceParams, body: addTimeBody, idempotent: true, tags, summary: 'Add approved billable time (each entry billed once)' }, async (req, res) => {
      sendOk(res, await invoiceService.addTime(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.get('/invoices/:invoiceId/billable-expenses', { permission: 'finance.invoices.manage', params: invoiceParams, tags, summary: 'Approved billable expenses not yet invoiced' }, async (req, res) => {
      sendOk(res, await invoiceService.billableExpenses(req.ctx, req.valid.params.invoiceId));
    });
    r.post('/invoices/:invoiceId/expenses', { permission: 'finance.invoices.manage', params: invoiceParams, body: addExpensesBody, idempotent: true, tags, summary: 'Add billable expenses' }, async (req, res) => {
      sendOk(res, await invoiceService.addExpenses(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.post('/invoices/:invoiceId/issue', { permission: 'finance.invoices.manage', params: invoiceParams, body: issueBody, idempotent: true, tags, summary: 'Issue (assigns the number)' }, async (req, res) => {
      sendOk(res, await invoiceService.issue(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.post('/invoices/:invoiceId/void', { permission: 'finance.invoices.manage', params: invoiceParams, body: z.object({ reason: text(500) }).strict(), tags, summary: 'Void (no net payments; frees time and expenses)' }, async (req, res) => {
      sendOk(res, await invoiceService.void(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
    r.post('/invoices/:invoiceId/payments', { permission: 'finance.payments.record', params: invoiceParams, body: paymentBody, idempotent: true, tags, summary: 'Record a payment or refund; status follows the ledger' }, async (req, res) => {
      sendCreated(res, await invoiceService.recordPayment(req.ctx, req.valid.params.invoiceId, req.valid.body));
    });
  });
}
