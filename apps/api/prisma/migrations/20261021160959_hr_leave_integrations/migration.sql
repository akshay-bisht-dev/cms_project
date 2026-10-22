-- AlterTable
ALTER TABLE `attendance_records` MODIFY `status` ENUM('PRESENT', 'ABSENT', 'HOLIDAY', 'LEAVE') NOT NULL DEFAULT 'PRESENT';

-- CreateTable
CREATE TABLE `leave_types` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `is_paid` BOOLEAN NOT NULL DEFAULT true,
    `allows_half_day` BOOLEAN NOT NULL DEFAULT true,
    `color` VARCHAR(7) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `leave_types_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `leave_types_organization_id_code_key`(`organization_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_policies` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `leave_type_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `accrual` ENUM('NONE', 'MONTHLY', 'ANNUAL') NOT NULL DEFAULT 'ANNUAL',
    `accrual_days` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    `cap_days` DECIMAL(6, 2) NULL,
    `carry_over_max_days` DECIMAL(6, 2) NULL,
    `allow_negative` BOOLEAN NOT NULL DEFAULT false,
    `approval_chain` JSON NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_policies_organization_id_leave_type_id_idx`(`organization_id`, `leave_type_id`),
    UNIQUE INDEX `leave_policies_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_policy_assignments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `policy_id` CHAR(36) NOT NULL,
    `target_type` ENUM('DEPARTMENT', 'TEAM', 'MEMBER') NOT NULL,
    `target_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_policy_assignments_organization_id_target_type_target__idx`(`organization_id`, `target_type`, `target_id`),
    UNIQUE INDEX `leave_policy_assignments_organization_id_policy_id_target_ty_key`(`organization_id`, `policy_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_ledger_entries` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `leave_type_id` CHAR(36) NOT NULL,
    `entry_type` ENUM('OPENING', 'ACCRUAL', 'USAGE', 'REVERSAL', 'ADJUSTMENT', 'CARRY_OVER', 'EXPIRY') NOT NULL,
    `days` DECIMAL(6, 2) NOT NULL,
    `effective_date` DATE NOT NULL,
    `leave_request_id` CHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `created_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_ledger_entries_organization_id_user_id_leave_type_id_e_idx`(`organization_id`, `user_id`, `leave_type_id`, `effective_date`),
    UNIQUE INDEX `leave_ledger_entries_organization_id_idempotency_key_key`(`organization_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `leave_type_id` CHAR(36) NOT NULL,
    `policy_id` CHAR(36) NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `start_half` ENUM('FULL', 'AM', 'PM') NOT NULL DEFAULT 'FULL',
    `end_half` ENUM('FULL', 'AM', 'PM') NOT NULL DEFAULT 'FULL',
    `days` DECIMAL(6, 2) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `chain` JSON NOT NULL,
    `current_step` INTEGER NOT NULL DEFAULT 0,
    `decided_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_requests_organization_id_user_id_start_date_idx`(`organization_id`, `user_id`, `start_date`),
    INDEX `leave_requests_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `leave_requests_organization_id_start_date_end_date_idx`(`organization_id`, `start_date`, `end_date`),
    UNIQUE INDEX `leave_requests_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_approvals` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `leave_request_id` CHAR(36) NOT NULL,
    `step` INTEGER NOT NULL,
    `actor_id` CHAR(36) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `comment` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_approvals_organization_id_leave_request_id_created_at_idx`(`organization_id`, `leave_request_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employment_documents` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(48) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `file_id` CHAR(36) NOT NULL,
    `visibility` ENUM('HR_ONLY', 'EMPLOYEE') NOT NULL DEFAULT 'HR_ONLY',
    `expires_on` DATE NULL,
    `uploaded_by_id` CHAR(36) NOT NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `taskId` CHAR(36) NULL,

    INDEX `employment_documents_organization_id_user_id_idx`(`organization_id`, `user_id`),
    INDEX `employment_documents_organization_id_expires_on_idx`(`organization_id`, `expires_on`),
    UNIQUE INDEX `employment_documents_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checklist_templates` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `kind` ENUM('ONBOARDING', 'OFFBOARDING') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `items` JSON NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `checklist_templates_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checklists` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `kind` ENUM('ONBOARDING', 'OFFBOARDING') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `template_id` CHAR(36) NULL,
    `started_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,

    INDEX `checklists_organization_id_user_id_kind_idx`(`organization_id`, `user_id`, `kind`),
    UNIQUE INDEX `checklists_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checklist_tasks` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `checklist_id` CHAR(36) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `assignee_role` VARCHAR(16) NOT NULL,
    `assignee_id` CHAR(36) NULL,
    `due_date` DATE NULL,
    `done_at` DATETIME(3) NULL,
    `done_by_id` CHAR(36) NULL,

    INDEX `checklist_tasks_organization_id_assignee_id_done_at_idx`(`organization_id`, `assignee_id`, `done_at`),
    UNIQUE INDEX `checklist_tasks_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_fields` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `entity` ENUM('EMPLOYEE', 'PROJECT', 'TASK', 'CLIENT', 'TICKET') NOT NULL,
    `key` VARCHAR(48) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `type` ENUM('TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN') NOT NULL,
    `options` JSON NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `custom_fields_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `custom_fields_organization_id_entity_key_key`(`organization_id`, `entity`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_values` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `field_id` CHAR(36) NOT NULL,
    `entity_id` CHAR(36) NOT NULL,
    `value_text` VARCHAR(1000) NULL,
    `value_number` DECIMAL(19, 4) NULL,
    `value_date` DATE NULL,
    `value_json` JSON NULL,
    `updated_by_id` CHAR(36) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `custom_field_values_organization_id_entity_id_idx`(`organization_id`, `entity_id`),
    INDEX `custom_field_values_organization_id_field_id_value_text_idx`(`organization_id`, `field_id`, `value_text`(64)),
    UNIQUE INDEX `custom_field_values_organization_id_field_id_entity_id_key`(`organization_id`, `field_id`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhooks` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `description` VARCHAR(200) NULL,
    `events` JSON NOT NULL,
    `secret_enc` TEXT NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `consecutive_failures` INTEGER NOT NULL DEFAULT 0,
    `disabled_reason` VARCHAR(200) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `webhooks_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `webhook_id` CHAR(36) NOT NULL,
    `event_id` CHAR(36) NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `fanout_key` VARCHAR(80) NULL,
    `replay_of_id` CHAR(36) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `status_code` INTEGER NULL,
    `response_ms` INTEGER NULL,
    `error` VARCHAR(500) NULL,
    `next_retry_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `webhook_deliveries_fanout_key_key`(`fanout_key`),
    INDEX `webhook_deliveries_organization_id_webhook_id_created_at_idx`(`organization_id`, `webhook_id`, `created_at`),
    INDEX `webhook_deliveries_status_next_retry_at_idx`(`status`, `next_retry_at`),
    UNIQUE INDEX `webhook_deliveries_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_keys` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `scopes` JSON NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `api_keys_prefix_key`(`prefix`),
    UNIQUE INDEX `api_keys_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `leave_policies` ADD CONSTRAINT `leave_policies_organization_id_leave_type_id_fkey` FOREIGN KEY (`organization_id`, `leave_type_id`) REFERENCES `leave_types`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_policy_assignments` ADD CONSTRAINT `leave_policy_assignments_organization_id_policy_id_fkey` FOREIGN KEY (`organization_id`, `policy_id`) REFERENCES `leave_policies`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_ledger_entries` ADD CONSTRAINT `leave_ledger_entries_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_ledger_entries` ADD CONSTRAINT `leave_ledger_entries_organization_id_leave_type_id_fkey` FOREIGN KEY (`organization_id`, `leave_type_id`) REFERENCES `leave_types`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_organization_id_leave_type_id_fkey` FOREIGN KEY (`organization_id`, `leave_type_id`) REFERENCES `leave_types`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `leave_approvals` ADD CONSTRAINT `leave_approvals_organization_id_leave_request_id_fkey` FOREIGN KEY (`organization_id`, `leave_request_id`) REFERENCES `leave_requests`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_documents` ADD CONSTRAINT `employment_documents_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_documents` ADD CONSTRAINT `employment_documents_organization_id_file_id_fkey` FOREIGN KEY (`organization_id`, `file_id`) REFERENCES `file_objects`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employment_documents` ADD CONSTRAINT `employment_documents_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checklists` ADD CONSTRAINT `checklists_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `checklist_tasks` ADD CONSTRAINT `checklist_tasks_organization_id_checklist_id_fkey` FOREIGN KEY (`organization_id`, `checklist_id`) REFERENCES `checklists`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `custom_field_values` ADD CONSTRAINT `custom_field_values_organization_id_field_id_fkey` FOREIGN KEY (`organization_id`, `field_id`) REFERENCES `custom_fields`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_organization_id_webhook_id_fkey` FOREIGN KEY (`organization_id`, `webhook_id`) REFERENCES `webhooks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_organization_id_created_by_id_fkey` FOREIGN KEY (`organization_id`, `created_by_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The leave ledger and approval history are append-only (FR-LV-1): corrections are new entries.
CREATE TRIGGER `leave_ledger_entries_block_update` BEFORE UPDATE ON `leave_ledger_entries`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_ledger_entries is append-only';
CREATE TRIGGER `leave_ledger_entries_block_delete` BEFORE DELETE ON `leave_ledger_entries`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_ledger_entries is append-only';
CREATE TRIGGER `leave_approvals_block_update` BEFORE UPDATE ON `leave_approvals`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'leave_approvals is append-only';

-- Leave days come in halves; a request always covers at least half a day.
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_days_positive` CHECK (`days` > 0 AND MOD(`days` * 2, 1) = 0);
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_dates_ordered` CHECK (`end_date` >= `start_date`);
