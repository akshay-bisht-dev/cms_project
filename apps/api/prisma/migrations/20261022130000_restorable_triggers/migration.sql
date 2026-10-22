-- Recreates every append-only/immutability trigger with a BEGIN … END body.
-- Found by the Phase 11 restore drill: Prisma runs a migration as one multi-statement batch, and MySQL
-- then stores the statement delimiter inside the body of every trigger that is not the file's last
-- statement ("… 'x';"). mysqldump wraps trigger bodies in /*!50003 … */, so that ';' ended the
-- statement early on restore and every logical backup failed to load. A BEGIN … END body is stored
-- as "BEGIN …; END" in any position. Each new trigger is created before the old one is dropped, so
-- the tables are never unprotected. tests/integration/backup.test.js guards against regressions.

CREATE TRIGGER `activity_events_no_update` BEFORE UPDATE ON `activity_events`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'activity_events is append-only'; END;
DROP TRIGGER `activity_events_block_update`;

CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'; END;
DROP TRIGGER `audit_logs_block_delete`;

CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'; END;
DROP TRIGGER `audit_logs_block_update`;

CREATE TRIGGER `leave_approvals_no_update` BEFORE UPDATE ON `leave_approvals`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_approvals is append-only'; END;
DROP TRIGGER `leave_approvals_block_update`;

CREATE TRIGGER `leave_ledger_entries_no_delete` BEFORE DELETE ON `leave_ledger_entries`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_ledger_entries is append-only'; END;
DROP TRIGGER `leave_ledger_entries_block_delete`;

CREATE TRIGGER `leave_ledger_entries_no_update` BEFORE UPDATE ON `leave_ledger_entries`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_ledger_entries is append-only'; END;
DROP TRIGGER `leave_ledger_entries_block_update`;

CREATE TRIGGER `monitoring_consent_records_no_delete` BEFORE DELETE ON `monitoring_consent_records`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_consent_records is append-only'; END;
DROP TRIGGER `monitoring_consent_records_block_delete`;

CREATE TRIGGER `monitoring_consent_records_no_update` BEFORE UPDATE ON `monitoring_consent_records`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_consent_records is append-only'; END;
DROP TRIGGER `monitoring_consent_records_block_update`;

CREATE TRIGGER `monitoring_policy_versions_no_update` BEFORE UPDATE ON `monitoring_policy_versions`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_policy_versions is immutable'; END;
DROP TRIGGER `monitoring_policy_versions_block_update`;

CREATE TRIGGER `payment_records_no_delete` BEFORE DELETE ON `payment_records`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_records is append-only'; END;
DROP TRIGGER `payment_records_block_delete`;

CREATE TRIGGER `payment_records_no_update` BEFORE UPDATE ON `payment_records`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_records is append-only'; END;
DROP TRIGGER `payment_records_block_update`;

CREATE TRIGGER `screenshot_access_logs_no_update` BEFORE UPDATE ON `screenshot_access_logs`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'screenshot_access_logs is append-only'; END;
DROP TRIGGER `screenshot_access_logs_block_update`;

CREATE TRIGGER `screenshot_deletion_logs_no_update` BEFORE UPDATE ON `screenshot_deletion_logs`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'screenshot_deletion_logs is append-only'; END;
DROP TRIGGER `screenshot_deletion_logs_block_update`;

CREATE TRIGGER `timesheet_approvals_no_delete` BEFORE DELETE ON `timesheet_approvals`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'timesheet_approvals is append-only'; END;
DROP TRIGGER `timesheet_approvals_block_delete`;

CREATE TRIGGER `timesheet_approvals_no_update` BEFORE UPDATE ON `timesheet_approvals`
FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'timesheet_approvals is append-only'; END;
DROP TRIGGER `timesheet_approvals_block_update`;
