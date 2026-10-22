# Role–Permission Matrix

## 1. Model

```
effective(member, permission, target) =
     NOT denied_by_override(member, permission)
 AND ∃ role ∈ member.roles : role grants permission with scope S
 AND target ∈ scopeSet(member, S)
 AND (target.projectId ⇒ project visibility/membership rules)
```

| Scope | Covers targets owned by… |
|---|---|
| `self` | the member themself |
| `team` | members of teams where the caller is **lead** (team members, if granted to non-leads) |
| `department` | members of departments the caller manages, including sub-departments |
| `project` | members and records of projects where the caller has project role MANAGER. For read-only grants, MEMBER also counts. |
| `org` | the whole active organization |

- Scopes are **unioned** across roles. A member who is both Team Lead and Project Manager sees the union.
- Overrides are **deny-only** and beat any grant.
- `scopeSet` is computed once per request and cached in Redis per member (TTL 5 min, busted on role, team, department, or project-membership change).
- **Separation of duties:** no one can approve their own timesheet, leave, expense, or attendance correction, even with org scope.
- **Anti-escalation:** assigning roles requires `roles.manage`, except that members with `invitations.manage` may assign the baseline **Employee** role and any role whose every grant they already hold at the same or wider scope. Nobody without `roles.manage` can grant **Owner**. The organization must always keep one active Owner.
- Every scope includes the caller themself (a `team`-scoped grant also covers the lead's own record).
- Super Admin holds **no org roles**. Tenant access requires an active `support_access_grant`, which yields a temporary read-only role, audited as `actor_type=SUPPORT`.

## 2. Matrix (system role defaults — orgs can edit copies)

`O`=org · `D`=department · `P`=project · `T`=team · `S`=self · `—`=none · `c`=off by default, owner can enable

| Permission | Owner | HR Mgr | Project Mgr | Team Lead | Employee | Finance Mgr | Client User |
|---|---|---|---|---|---|---|---|
| **Organization & admin** | | | | | | | |
| org.settings.read | O | O | O | O | O (basic) | O | — |
| org.settings.manage | O | — | — | — | — | — | — |
| org.billing.manage (subscription, limits) | O | — | — | — | — | — | — |
| roles.manage | O | — | — | — | — | — | — |
| departments.manage / teams.manage | O | O | — | T (own team membership) | — | — | — |
| customfields.manage | O | O | — | — | — | — | — |
| integrations.manage · webhooks.manage · apikeys.manage | O | — | — | — | — | — | — |
| audit.read | O | c (HR-module actions) | — | — | — | c (finance actions) | — |
| org.data.manage (export / erasure) | O | — | — | — | — | — | — |
| **People** | | | | | | | |
| employees.read (directory, basic fields) | O | O | O | O | O | O | — |
| employees.fields.work.read | O | O | P | T | S | O | — |
| employees.fields.contact.read | O | O | P | T | S | — | — |
| employees.fields.personal.read / update | O | O | — | — | S | — | — |
| employees.fields.emergency.read / update | c | O | — | — | S | — | — |
| employees.fields.employment.read / update | O | O | — | — | S (read) | O (read) | — |
| employees.create · invitations.manage | O | O | — | — | — | — | — |
| employees.update (work fields) | O | O | — | — | — | — | — |
| employees.deactivate / offboard / archive | O | O | — | — | — | — | — |
| employees.export | O | O | — | — | — | — | — |
| employment documents (read / manage) | O | O | — | — | S (read, EMPLOYEE visibility) | — | — |
| **Attendance & time** | | | | | | | |
| attendance.self (clock, break) | O | S | S | S | S | S | — |
| attendance.read | O | O | P | T | S | — | — |
| attendance.correct.request | S | S | S | S | S | S | — |
| attendance.correct.approve | O | O | — | T | — | — | — |
| time.self (timer) · time.manual (own) | S | S | S | S | S | S | — |
| time.read | O | O | P | T | S | O (billable only) | — |
| time.edit.others | O | — | P | — | — | — | — |
| timesheets.submit | S | S | S | S | S | S | — |
| timesheets.read | O | O | P | T | S | O | — |
| timesheets.approve | O | c | P | T | — | — | — |
| timesheets.unlock (reopen approved) | O | — | — | — | — | c | — |
| **Monitoring** | | | | | | | |
| monitoring.self (status, own screenshots, consent, agents) | S | S | S | S | S | S | — |
| monitoring.policy.read | O | O | — | — | S (effective policy) | — | — |
| monitoring.policy.manage | O | — | — | — | — | — | — |
| monitoring.screenshots.read | O | c | P (project-tagged captures only) | T | S | — | — |
| monitoring.screenshots.download | O | — | c | c | S | — | — |
| monitoring.screenshots.delete | O | — | — | — | — | — | — |
| monitoring.legalhold.manage | O | c | — | — | — | — | — |
| monitoring.agents.manage | O | — | — | — | S (own) | — | — |
| **Projects & tasks** | | | | | | | |
| projects.read | O | O (org-visible) | P + org-visible | P + org-visible | P + org-visible | O | shared projects (status only) |
| projects.create | O | — | O | — | — | — | — |
| projects.manage (edit, members, milestones, archive) | O | — | P | — | — | — | — |
| projects.budget.read | O | — | P | — | — | O | c |
| tasks.read | O | — | P | P | P | — | shared tasks |
| tasks.create / update / assign | O | — | P | P (create/update) | P (assigned: update status, comment) | — | — |
| **CRM & tickets** | | | | | | | |
| clients.read | O | — | P (own projects' clients) | — | — | O | own client |
| clients.manage | O | — | — | — | — | c | — |
| leads.manage · opportunities.manage · quotes.manage | O | — | c | — | — | c | — |
| tickets.read | O | — | P | T (assigned team) | assigned | — | — |
| tickets.manage | O | — | P | T | assigned (update, comment) | — | — |
| tickets.client (portal create/comment PUBLIC) | — | — | — | — | — | — | own client |
| **Leave** | | | | | | | |
| leave.self (request, cancel own) | S | S | S | S | S | S | — |
| leave.read | O | O | P (availability only) | T | S | — | — |
| leave.approve | O | O | — | T | — | — | — |
| leave.policy.manage · leave.balance.adjust | O | O | — | — | — | — | — |
| **Finance** | | | | | | | |
| finance.expenses.submit | S | S | S | S | S | S | — |
| finance.expenses.approve | O | — | P (project expenses) | — | — | O | — |
| finance.invoices.manage · finance.payments.record | O | — | — | — | — | O | — |
| finance.invoices.read | O | — | c (project) | — | — | O | own client (ISSUED+) |
| finance.rates.manage | O | — | — | — | — | O | — |
| finance.cost.read (cost rates, margins) | O | — | — | — | — | O | — |
| **Reports & dashboard** | | | | | | | |
| dashboard.read | O | O | P | T | S | O | — |
| reports.attendance.read | O | O | P | T | S | — | — |
| reports.projects.read | O | — | P | T | — | O | — |
| reports.monitoring.read | O | — | P | T | S | — | — |
| reports.crm.read | O | — | — | — | — | O | — |
| reports.finance.read | O | — | c (project margins) | — | — | O | — |
| reports.export | O | O | P | T | S | O | — |

## 3. Platform Super Admin (outside org RBAC)

| Capability | Allowed |
|---|---|
| List orgs, plan/limits, status (suspend/reactivate) | ✓ (A) |
| Platform health, queues, error rates | ✓ |
| Global config, feature flags, permission catalog | ✓ (A) |
| Read tenant data | Only under an approved, unexpired `support_access_grant`: read-only, the scope listed in the grant, every request audited, and the org owner notified |
| Read screenshots, HR-sensitive fields, cost rates | ✗ even under grant, unless the grant explicitly lists the scope **and** the owner approved that scope |

## 4. Field-level rules for profile APIs

- Responses are built by **field-group serializers**: each group is included only if the matching `employees.fields.<group>.read` permission covers the target.
- PATCH bodies are partitioned by group. A field in a group the caller cannot write → 403 `FORBIDDEN` naming the field (not silently ignored).
- Always excluded: `password_hash`, `totp_secret`, `recovery_codes`, session tokens, API key hashes. The serializer allow-lists fields. No `select *` is ever passed through.
