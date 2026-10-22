# Release checklist

Copy into the release issue and tick each line. Automation does most of it
([release.yml](../.github/workflows/release.yml)); people own the decisions.

## Before tagging
- [ ] `main` is green: lint (including `check-deploy`), unit, integration (backup round trip included),
      E2E with the least-privilege app user, image build and scan, compose infra suite.
- [ ] Migrations reviewed for **expand/contract**: the previous release must keep working on the new
      schema (no dropped or renamed columns still read by it; new columns nullable or defaulted).
      Destructive steps wait for the following release.
- [ ] New triggers use `BEGIN … END` bodies (`backup.test.js` enforces restorable trigger bodies).
- [ ] Large-table changes (time entries, activity, audit, screenshots) checked for lock time; use an
      online schema-change tool if they rebuild a big table.
- [ ] New environment variables documented in `docs/environment.md` (`environment-docs.test.js`) and
      present in every environment's secret store.
- [ ] `openapi/openapi.json` regenerated (CI checks for drift); breaking API changes versioned or announced
      to integrators (webhooks and API keys: [integrations.md](integrations.md)).
- [ ] `pnpm audit --prod` clean, or each finding accepted in [security-checklist.md](security-checklist.md).
- [ ] Performance-sensitive changes load-tested ([performance.md](performance.md)): p95 < 500 ms at 10 users.
- [ ] Changelog and user-facing notes written; anything that changes what is monitored is announced to
      employees in advance (monitoring transparency).

## Release
- [ ] Tag `vX.Y.Z` on the commit that passed CI.
- [ ] Release workflow: images built, scanned, pushed, **signed**, with SBOM and provenance.
- [ ] Staging deployed automatically; smoke test passed; quick manual pass of sign-in, clock in/out,
      timer, a timesheet approval, an invoice PDF, and the screenshot timeline with a test agent.
- [ ] Production approved in the `production` environment by someone other than the author.
- [ ] Deploy script: **fresh backup completed** → migration Job completed → rollout ready → smoke test.

## After
- [ ] Dashboards for 30 minutes: p95 latency, 5xx rate, queue failures, outbox lag (alerts in
      `infrastructure/monitoring/alert-rules.yml`).
- [ ] Spot-check the audit log for the release window (unexpected actions or errors).
- [ ] Desktop agent: if released, signed installers verified (`agent-release.yml`) and the update feed points at them.

## Rolling back
1. `kubectl -n orbit rollout undo deployment/api deployment/worker deployment/web` (the deploy script does
   this automatically if the rollout fails), or set the previous `ORBIT_VERSION` and run
   `docker compose up -d`.
2. The schema stays: expand/contract makes the previous version compatible. Never run a "down" migration.
3. Restoring the database is the last resort ([backup-restore.md](backup-restore.md), runbook A). It loses
   data written since the backup, so it needs the incident lead's decision.
