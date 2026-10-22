# Phase 9: CRM, support & finance (report)

**Date:** 2026-10-21 · **Status:** complete (background SLA checks not yet run against a real Redis worker)

## Objective
Clients and sales (leads to conversion, pipeline with forecast, quotes, agreements), support tickets with SLAs, and finance: rates, expenses, invoices from approved time, and payments. Plus a client portal that shows each client only its own data. The acceptance criteria require:
- exact decimal maths;
- an invoice can never be PAID without payments;
- time is never billed twice;
- client users see only their own client.

## What was built
- **Schema** (migrations `…_crm_finance`, `…_project_client_sharing`):
  - **CRM:** clients, contacts, communication notes, leads, pipeline stages, opportunities, sales activities.
  - **Support:** SLA policies, tickets, ticket comments.
  - **Sales documents:** service agreements, quotes and quote items.
  - **Finance:** exchange rates, billing/cost rates, expense categories, expenses, invoices, invoice items, the invoice↔time-entry and invoice↔expense links, payment records.
  - **Supporting:** document sequences; `organization_members.client_id` for portal users; `projects.shared_with_client`.
  - **Database guarantees:**
    - `CHECK (status <> 'PAID' OR (amount_paid >= total AND amount_paid > 0))`;
    - `amount_paid >= 0`;
    - issued invoices must have a number;
    - triggers make `payment_records` append-only;
    - `UNIQUE(organization_id, time_entry_id)` and `UNIQUE(organization_id, expense_id)` on the invoice links.
- **Money** (`finance/money.js`):
  - Decimal arithmetic via `Prisma.Decimal`, with amounts as strings in the API.
  - Banker's rounding at ISO 4217 minor units (JPY 0, KWD/BHD 3, …), rounded per line then summed.
  - Hours are exact (4 decimal places).
  - The base currency comes from rates entered by Finance; unconvertible amounts are reported, never guessed.
- **Clients:**
  - Access is org-wide, or the clients of projects you manage.
  - Contacts (one primary), communication history, agreements, and outstanding balance (finance only).
  - Generated codes; projects can be linked and shared with the client.
- **Sales:**
  - The lead workflow has guarded transitions; LOST needs a reason.
  - Converting is atomic and happens once: it creates a client, a primary contact and optionally an opportunity in the first open stage.
  - The default pipeline is created on first use. Moving to a stage applies its probability; Won/Lost close the deal, and Lost needs a reason.
  - **Pipeline value (measured)** and **weighted forecast (estimated)** are in the base currency.
  - Sales follow-ups.
  - **Quotes:**
    - sequential numbers (QUO-NNNNN) with exact totals;
    - flow: DRAFT → SENT → ACCEPTED/DECLINED, and expiry is shown;
    - revisions are new versions under the same number, with the old version SUPERSEDED;
    - accepting a quote wins its opportunity.
- **Support:**
  - Ticket numbers (T-N) and priorities.
  - SLA deadlines computed in **business hours** (work schedule plus holidays, DST-safe) or around the clock.
  - The first public staff reply records the first response.
  - Breach flags are set on resolve or close, and by a job every 10 minutes, which notifies the assignee (or the team lead).
  - Scope: assigned or reported (self), teams led, projects managed, or org.
  - Internal notes need read permission; public replies need manage. A client reply reopens a ticket that was waiting on them.
- **Finance:**
  - **Rates:**
    - Billing precedence: project-member > project > client > member > organization.
    - Cost rates (member or organization) are visible only with `finance.cost.read`.
    - Overlapping periods are refused; rates are ended, never edited.
    - Exchange rates and expense categories.
  - **Expenses:**
    - draft → submitted → approved/rejected → reimbursed;
    - the approver is a project manager of the expense's project, or finance — never the submitter;
    - rejecting needs a comment;
    - receipts are private, presigned uploads;
    - the submitter is notified of the decision.
  - **Invoices:**
    - Drafts take manual lines, approved billable time (preview first; grouped by person and project, project, or entry; priced on each entry's day) and approved billable expenses in the same currency.
    - Issuing assigns a gap-free number (INV-NNNNN) and a due date from the client's terms.
    - Voiding requires no net payments, and frees the time and expenses for re-billing.
    - Payments and refunds are recorded under a row lock, and the status is re-derived from the payment ledger.
    - Invoices past their due date are flagged overdue; PDFs are available.
- **Client portal** (`/portal`):
  - Client users land there and are redirected away from the internal app.
  - They see shared projects (status and milestones), their client's tickets (public replies only; raise and reply) and issued invoices (with PDF).
  - **Structural isolation:** client members are refused on *every* API route not marked `allowClient`, regardless of roles. The generated test checks this for all 278 operations with a client user holding the OWNER role.
- **Reports:** five new ones:
  - **pipeline** by stage;
  - **lead conversion** by source (cohort);
  - **support & SLA attainment** by client or priority;
  - **revenue & receivables** by client or month;
  - **project margins** (revenue − time × cost rate − expenses).

  All are labelled measured, derived or estimated, and export to CSV/PDF.
- **UI:**
  - Clients list and detail (overview, communication, tickets, invoices, agreements, portal access).
  - Leads (move, convert), Pipeline board with value and forecast tiles, Quotes (line editor with exact tax %).
  - Support tickets (list views, SLA badges, conversation with internal notes, assignment).
  - Invoices (list views, draft builder: time preview, expenses, manual lines; issue, record payment, void, PDF) and Expenses (mine, to approve, all; receipt upload).
  - Settings → Finance (rates, exchange rates, categories) and Sales & support (stages, SLA hours and business hours).
  - The client portal.
  - Navigation has Clients & sales and Finance groups.

## Verification (run on 2026-10-21)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit | **99/99** (+6 money: half-even, minor units, no float drift, per-line rounding, hours, status from payments; +3 business hours) |
| API integration (real MySQL) | **939/939**. 278 operations in the generated 401 and 403 suites, plus the new "client user → 403 on every internal route" suite. 22 new behavior tests (finance 13, CRM, sales and support 9). |
| Desktop agent / web unit | **34/34** · **17/17** |
| Playwright E2E + axe | **25/25** (+5: finance issues an invoice and records a partial payment; owner converts a lead and sees the pipeline; developer replies publicly and internally; client portal isolation; expense submit and approve) |
| Visual review | invoice, pipeline, client, portal (1440 px); portal invoices (390 px, no page overflow measured) |

Acceptance tests that ran:
- **Decimal maths:** unit fixtures, plus exact totals end to end (₹2,950.00 = 2 × 1,250 + 18 %; 1.3333 h × 75 → 100.00 + 18.00 tax).
- **No PAID without payments:**
  - no API sets a status;
  - a raw `UPDATE … SET status='PAID'` is rejected by the CHECK constraint;
  - payment rows refuse UPDATE and DELETE;
  - 5 concurrent payments of 40 against a 100 invoice → exactly 2 succeed.
- **No double billing:**
  - two drafts race to add the same time → exactly one link;
  - a second link insert fails at the database;
  - removing a line, deleting a draft or voiding an invoice frees the time;
  - expenses can't go on two invoices.
- **Client sees only their own client:** portal projects, tickets, comments and invoices are filtered (other clients, drafts and internal notes return 404 or are absent); 8 internal endpoints return 403 for the portal user; staff are refused on the portal; revoking access signs the user out.

## Bugs found and fixed
1. **Client users could reach internal MEMBER-level routes** (calendar, tasks, schedules, roles), because those only checked membership. Fixed structurally with the `allowClient` route flag, now enforced for every route by the generated test.
2. **Keyboard scrolling:** wide portal tables now expose a keyboard-scrollable region (opt-in `scrollable` on `DataTable`).
3. **Test-side mistakes:** two of my expected values were wrong arithmetic (rounding 99.9975, and a business-hours deadline); the code was right both times. The E2E test assumed USD where the seeded organization uses INR. A shell loop used `path` as a variable name, which clobbered `PATH` in zsh.

## Limitations
- **Not run on real infrastructure:** the SLA breach job is tested as a function, but its BullMQ schedule hasn't run on Redis (no Docker here). Receipt uploads to real S3 are untested; tests use the in-memory store.
- **Not built:**
  - an SLA pause while a ticket is waiting on the client;
  - email-to-ticket;
  - quote PDFs and e-signature;
  - recurring invoices;
  - credit notes (refunds are negative payments);
  - per-line tax schemes beyond one rate (e.g. compound tax).
- **Overdue notifications:** overdue is flagged in lists and reports, but nobody is notified yet.
- **Multi-currency:** invoices bill only rates and expenses in the invoice's currency; conversion is for reporting only.

## Acceptance criteria
| Criterion | Status |
|---|---|
| Decimal maths tests | ✅ |
| Invoice can't be PAID without payments | ✅ (API + DB CHECK + append-only ledger + concurrency) |
| No double-billing of time entries | ✅ (unique link + race test) |
| Client user sees only their own client data | ✅ (portal filters + structural route guard tested on every route) |
