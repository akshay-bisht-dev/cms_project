-- AlterTable
ALTER TABLE `organization_members` ADD COLUMN `client_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `document_sequences` (
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(16) NOT NULL,
    `next_value` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`organization_id`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clients` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `industry` VARCHAR(80) NULL,
    `size_band` VARCHAR(16) NULL,
    `website` VARCHAR(255) NULL,
    `email` VARCHAR(254) NULL,
    `phone` VARCHAR(40) NULL,
    `address` JSON NULL,
    `country` CHAR(2) NULL,
    `tax_id` VARCHAR(64) NULL,
    `account_manager_id` CHAR(36) NULL,
    `status` ENUM('PROSPECT', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'PROSPECT',
    `default_currency` CHAR(3) NOT NULL,
    `payment_terms_days` SMALLINT NOT NULL DEFAULT 30,
    `archived_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `clients_organization_id_status_archived_at_idx`(`organization_id`, `status`, `archived_at`),
    INDEX `clients_organization_id_name_idx`(`organization_id`, `name`),
    UNIQUE INDEX `clients_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `clients_organization_id_code_key`(`organization_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_contacts` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `email` VARCHAR(254) NULL,
    `phone` VARCHAR(40) NULL,
    `title` VARCHAR(120) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `client_contacts_organization_id_client_id_idx`(`organization_id`, `client_id`),
    UNIQUE INDEX `client_contacts_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_notes` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NOT NULL,
    `kind` ENUM('NOTE', 'CALL', 'EMAIL', 'MEETING') NOT NULL DEFAULT 'NOTE',
    `body` TEXT NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `author_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `client_notes_organization_id_client_id_occurred_at_idx`(`organization_id`, `client_id`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `company` VARCHAR(200) NULL,
    `email` VARCHAR(254) NULL,
    `phone` VARCHAR(40) NULL,
    `source` VARCHAR(48) NULL,
    `owner_id` CHAR(36) NULL,
    `status` ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST') NOT NULL DEFAULT 'NEW',
    `score` SMALLINT NULL,
    `follow_up_at` DATETIME(3) NULL,
    `lost_reason` VARCHAR(500) NULL,
    `notes` TEXT NULL,
    `estimated_value` DECIMAL(19, 4) NULL,
    `currency` CHAR(3) NULL,
    `converted_client_id` CHAR(36) NULL,
    `converted_opportunity_id` CHAR(36) NULL,
    `converted_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leads_organization_id_status_owner_id_idx`(`organization_id`, `status`, `owner_id`),
    INDEX `leads_organization_id_follow_up_at_idx`(`organization_id`, `follow_up_at`),
    INDEX `leads_organization_id_created_at_idx`(`organization_id`, `created_at`),
    UNIQUE INDEX `leads_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_stages` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `default_probability` SMALLINT NOT NULL,
    `is_won` BOOLEAN NOT NULL DEFAULT false,
    `is_lost` BOOLEAN NOT NULL DEFAULT false,
    `archived_at` DATETIME(3) NULL,

    UNIQUE INDEX `pipeline_stages_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `pipeline_stages_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `opportunities` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NULL,
    `lead_id` CHAR(36) NULL,
    `name` VARCHAR(200) NOT NULL,
    `stage_id` CHAR(36) NOT NULL,
    `value` DECIMAL(19, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `probability` SMALLINT NOT NULL,
    `expected_close_date` DATE NULL,
    `owner_id` CHAR(36) NULL,
    `closed_at` DATETIME(3) NULL,
    `lost_reason` VARCHAR(500) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `opportunities_organization_id_stage_id_idx`(`organization_id`, `stage_id`),
    INDEX `opportunities_organization_id_expected_close_date_idx`(`organization_id`, `expected_close_date`),
    UNIQUE INDEX `opportunities_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_activities` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `subject_type` ENUM('LEAD', 'OPPORTUNITY', 'CLIENT') NOT NULL,
    `subject_id` CHAR(36) NOT NULL,
    `kind` ENUM('NOTE', 'CALL', 'EMAIL', 'MEETING') NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `due_at` DATETIME(3) NULL,
    `done_at` DATETIME(3) NULL,
    `owner_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sales_activities_organization_id_subject_type_subject_id_idx`(`organization_id`, `subject_type`, `subject_id`),
    INDEX `sales_activities_organization_id_owner_id_done_at_due_at_idx`(`organization_id`, `owner_id`, `done_at`, `due_at`),
    UNIQUE INDEX `sales_activities_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sla_policies` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `targets` JSON NOT NULL,
    `schedule_id` CHAR(36) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sla_policies_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `support_tickets` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `client_id` CHAR(36) NULL,
    `project_id` CHAR(36) NULL,
    `reporter_id` CHAR(36) NOT NULL,
    `subject` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `status` ENUM('OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `team_id` CHAR(36) NULL,
    `assignee_id` CHAR(36) NULL,
    `sla_policy_id` CHAR(36) NULL,
    `first_response_due_at` DATETIME(3) NULL,
    `resolution_due_at` DATETIME(3) NULL,
    `first_responded_at` DATETIME(3) NULL,
    `resolved_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `first_response_breached` BOOLEAN NOT NULL DEFAULT false,
    `sla_breached` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `support_tickets_organization_id_status_priority_idx`(`organization_id`, `status`, `priority`),
    INDEX `support_tickets_organization_id_resolution_due_at_idx`(`organization_id`, `resolution_due_at`),
    INDEX `support_tickets_organization_id_client_id_created_at_idx`(`organization_id`, `client_id`, `created_at`),
    INDEX `support_tickets_organization_id_assignee_id_status_idx`(`organization_id`, `assignee_id`, `status`),
    UNIQUE INDEX `support_tickets_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `support_tickets_organization_id_number_key`(`organization_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ticket_comments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `ticket_id` CHAR(36) NOT NULL,
    `author_id` CHAR(36) NOT NULL,
    `visibility` ENUM('INTERNAL', 'PUBLIC') NOT NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ticket_comments_organization_id_ticket_id_created_at_idx`(`organization_id`, `ticket_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `service_agreements` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NULL,
    `value` DECIMAL(19, 4) NULL,
    `currency` CHAR(3) NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED') NOT NULL DEFAULT 'DRAFT',
    `terms` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `service_agreements_organization_id_client_id_idx`(`organization_id`, `client_id`),
    UNIQUE INDEX `service_agreements_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quotes` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NOT NULL,
    `opportunity_id` CHAR(36) NULL,
    `number` VARCHAR(32) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `title` VARCHAR(200) NOT NULL,
    `valid_until` DATE NULL,
    `currency` CHAR(3) NOT NULL,
    `subtotal` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `total` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `sent_at` DATETIME(3) NULL,
    `decided_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `quotes_organization_id_client_id_created_at_idx`(`organization_id`, `client_id`, `created_at`),
    UNIQUE INDEX `quotes_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `quotes_organization_id_number_version_key`(`organization_id`, `number`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quote_items` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `quote_id` CHAR(36) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `quantity` DECIMAL(12, 4) NOT NULL,
    `unit_price` DECIMAL(19, 4) NOT NULL,
    `tax_rate` DECIMAL(6, 4) NOT NULL,
    `line_total` DECIMAL(19, 4) NOT NULL,
    `tax_amount` DECIMAL(19, 4) NOT NULL,

    INDEX `quote_items_organization_id_quote_id_idx`(`organization_id`, `quote_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rates` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `rate_to_base` DECIMAL(19, 8) NOT NULL,
    `effective_from` DATE NOT NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `exchange_rates_organization_id_currency_effective_from_key`(`organization_id`, `currency`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_rates` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `kind` ENUM('BILL', 'COST') NOT NULL,
    `target_type` ENUM('ORG', 'MEMBER', 'CLIENT', 'PROJECT', 'PROJECT_MEMBER') NOT NULL,
    `target_id` CHAR(36) NULL,
    `project_id` CHAR(36) NULL,
    `amount` DECIMAL(19, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `billing_rates_organization_id_kind_target_type_target_id_eff_idx`(`organization_id`, `kind`, `target_type`, `target_id`, `effective_from`),
    UNIQUE INDEX `billing_rates_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense_categories` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `archived_at` DATETIME(3) NULL,

    UNIQUE INDEX `expense_categories_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `expense_categories_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NULL,
    `client_id` CHAR(36) NULL,
    `category_id` CHAR(36) NULL,
    `description` VARCHAR(500) NOT NULL,
    `amount` DECIMAL(19, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `incurred_on` DATE NOT NULL,
    `is_billable` BOOLEAN NOT NULL DEFAULT false,
    `receipt_file_id` CHAR(36) NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED') NOT NULL DEFAULT 'DRAFT',
    `submitted_at` DATETIME(3) NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by_id` CHAR(36) NULL,
    `decision_comment` VARCHAR(500) NULL,
    `reimbursed_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `taskId` CHAR(36) NULL,

    INDEX `expenses_organization_id_user_id_incurred_on_idx`(`organization_id`, `user_id`, `incurred_on`),
    INDEX `expenses_organization_id_project_id_incurred_on_idx`(`organization_id`, `project_id`, `incurred_on`),
    INDEX `expenses_organization_id_status_idx`(`organization_id`, `status`),
    UNIQUE INDEX `expenses_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `client_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NULL,
    `number` VARCHAR(32) NULL,
    `status` ENUM('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID') NOT NULL DEFAULT 'DRAFT',
    `issue_date` DATE NULL,
    `due_date` DATE NULL,
    `currency` CHAR(3) NOT NULL,
    `subtotal` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `total` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `amount_paid` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `issued_by_id` CHAR(36) NULL,
    `voided_at` DATETIME(3) NULL,
    `void_reason` VARCHAR(500) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `invoices_organization_id_status_due_date_idx`(`organization_id`, `status`, `due_date`),
    INDEX `invoices_organization_id_client_id_issue_date_idx`(`organization_id`, `client_id`, `issue_date`),
    UNIQUE INDEX `invoices_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `invoices_organization_id_number_key`(`organization_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_items` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `invoice_id` CHAR(36) NOT NULL,
    `kind` ENUM('TIME', 'EXPENSE', 'MANUAL') NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `quantity` DECIMAL(12, 4) NOT NULL,
    `unit_price` DECIMAL(19, 4) NOT NULL,
    `tax_rate` DECIMAL(6, 4) NOT NULL,
    `line_total` DECIMAL(19, 4) NOT NULL,
    `tax_amount` DECIMAL(19, 4) NOT NULL,
    `project_id` CHAR(36) NULL,

    INDEX `invoice_items_organization_id_invoice_id_idx`(`organization_id`, `invoice_id`),
    UNIQUE INDEX `invoice_items_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_item_time_entries` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `invoice_item_id` CHAR(36) NOT NULL,
    `time_entry_id` CHAR(36) NOT NULL,

    INDEX `invoice_item_time_entries_organization_id_invoice_item_id_idx`(`organization_id`, `invoice_item_id`),
    UNIQUE INDEX `invoice_item_time_entries_organization_id_time_entry_id_key`(`organization_id`, `time_entry_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_item_expenses` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `invoice_item_id` CHAR(36) NOT NULL,
    `expense_id` CHAR(36) NOT NULL,

    INDEX `invoice_item_expenses_organization_id_invoice_item_id_idx`(`organization_id`, `invoice_item_id`),
    UNIQUE INDEX `invoice_item_expenses_organization_id_expense_id_key`(`organization_id`, `expense_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_records` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `invoice_id` CHAR(36) NOT NULL,
    `amount` DECIMAL(19, 4) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `received_on` DATE NOT NULL,
    `method` ENUM('BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE', 'OTHER') NOT NULL,
    `reference` VARCHAR(120) NULL,
    `note` VARCHAR(500) NULL,
    `recorded_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_records_organization_id_invoice_id_idx`(`organization_id`, `invoice_id`),
    INDEX `payment_records_organization_id_received_on_idx`(`organization_id`, `received_on`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `client_contacts` ADD CONSTRAINT `client_contacts_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `client_notes` ADD CONSTRAINT `client_notes_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_organization_id_stage_id_fkey` FOREIGN KEY (`organization_id`, `stage_id`) REFERENCES `pipeline_stages`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sla_policies` ADD CONSTRAINT `sla_policies_organization_id_schedule_id_fkey` FOREIGN KEY (`organization_id`, `schedule_id`) REFERENCES `work_schedules`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_organization_id_reporter_id_fkey` FOREIGN KEY (`organization_id`, `reporter_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_organization_id_sla_policy_id_fkey` FOREIGN KEY (`organization_id`, `sla_policy_id`) REFERENCES `sla_policies`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ticket_comments` ADD CONSTRAINT `ticket_comments_organization_id_ticket_id_fkey` FOREIGN KEY (`organization_id`, `ticket_id`) REFERENCES `support_tickets`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `service_agreements` ADD CONSTRAINT `service_agreements_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quotes` ADD CONSTRAINT `quotes_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quotes` ADD CONSTRAINT `quotes_organization_id_opportunity_id_fkey` FOREIGN KEY (`organization_id`, `opportunity_id`) REFERENCES `opportunities`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `quote_items` ADD CONSTRAINT `quote_items_organization_id_quote_id_fkey` FOREIGN KEY (`organization_id`, `quote_id`) REFERENCES `quotes`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_organization_id_category_id_fkey` FOREIGN KEY (`organization_id`, `category_id`) REFERENCES `expense_categories`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_organization_id_receipt_file_id_fkey` FOREIGN KEY (`organization_id`, `receipt_file_id`) REFERENCES `file_objects`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_organization_id_client_id_fkey` FOREIGN KEY (`organization_id`, `client_id`) REFERENCES `clients`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_items` ADD CONSTRAINT `invoice_items_organization_id_invoice_id_fkey` FOREIGN KEY (`organization_id`, `invoice_id`) REFERENCES `invoices`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_item_time_entries` ADD CONSTRAINT `invoice_item_time_entries_organization_id_invoice_item_id_fkey` FOREIGN KEY (`organization_id`, `invoice_item_id`) REFERENCES `invoice_items`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_item_time_entries` ADD CONSTRAINT `invoice_item_time_entries_organization_id_time_entry_id_fkey` FOREIGN KEY (`organization_id`, `time_entry_id`) REFERENCES `time_entries`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_item_expenses` ADD CONSTRAINT `invoice_item_expenses_organization_id_invoice_item_id_fkey` FOREIGN KEY (`organization_id`, `invoice_item_id`) REFERENCES `invoice_items`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invoice_item_expenses` ADD CONSTRAINT `invoice_item_expenses_organization_id_expense_id_fkey` FOREIGN KEY (`organization_id`, `expense_id`) REFERENCES `expenses`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_records` ADD CONSTRAINT `payment_records_organization_id_invoice_id_fkey` FOREIGN KEY (`organization_id`, `invoice_id`) REFERENCES `invoices`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An invoice is PAID only when recorded payments cover its total (FR-FIN-3), never by a flag.
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_paid_requires_payments`
  CHECK (`status` <> 'PAID' OR (`amount_paid` >= `total` AND `amount_paid` > 0));
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_amount_paid_non_negative` CHECK (`amount_paid` >= 0);
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_issued_have_number`
  CHECK (`status` = 'DRAFT' OR `number` IS NOT NULL);

-- Payments are a ledger: corrections are new (negative) records, never edits.
CREATE TRIGGER `payment_records_block_update` BEFORE UPDATE ON `payment_records`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_records is append-only';

CREATE TRIGGER `payment_records_block_delete` BEFORE DELETE ON `payment_records`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_records is append-only';
