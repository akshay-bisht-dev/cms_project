-- Organization-wide time ranges (dashboard "tracked today"): found by the Phase 11 load test, where the
-- query scanned every entry of the organization.
-- CreateIndex
CREATE INDEX `time_entries_organization_id_started_at_idx` ON `time_entries`(`organization_id`, `started_at`);

