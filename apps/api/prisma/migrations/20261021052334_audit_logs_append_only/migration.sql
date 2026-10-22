-- Audit logs are append-only (docs/database-design.md §7). Retention removes whole monthly
-- partitions (DROP PARTITION), which does not fire row triggers, so these guards stay compatible.
CREATE TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER `audit_logs_block_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
