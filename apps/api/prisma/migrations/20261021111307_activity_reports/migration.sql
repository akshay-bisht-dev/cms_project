-- CreateTable
CREATE TABLE `activity_events` (
    `id` CHAR(36) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(48) NOT NULL,
    `subject_type` VARCHAR(32) NULL,
    `subject_id` CHAR(36) NULL,
    `project_id` CHAR(36) NULL,
    `duration_s` INTEGER NULL,
    `metadata` JSON NULL,

    INDEX `activity_events_organization_id_user_id_occurred_at_idx`(`organization_id`, `user_id`, `occurred_at`),
    INDEX `activity_events_organization_id_occurred_at_idx`(`organization_id`, `occurred_at`),
    PRIMARY KEY (`id`, `occurred_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_member_stats` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `date` DATE NOT NULL,
    `time_zone` VARCHAR(64) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `scheduled_s` INTEGER NOT NULL DEFAULT 0,
    `worked_s` INTEGER NOT NULL DEFAULT 0,
    `break_s` INTEGER NOT NULL DEFAULT 0,
    `late_by_s` INTEGER NOT NULL DEFAULT 0,
    `overtime_s` INTEGER NOT NULL DEFAULT 0,
    `tracked_s` INTEGER NOT NULL DEFAULT 0,
    `billable_s` INTEGER NOT NULL DEFAULT 0,
    `idle_s` INTEGER NOT NULL DEFAULT 0,
    `monitored_s` INTEGER NOT NULL DEFAULT 0,
    `screenshots_expected` INTEGER NOT NULL DEFAULT 0,
    `screenshots_ok` INTEGER NOT NULL DEFAULT 0,
    `screenshots_failed` INTEGER NOT NULL DEFAULT 0,
    `tasks_completed` INTEGER NOT NULL DEFAULT 0,
    `computed_at` DATETIME(3) NOT NULL,

    INDEX `daily_member_stats_organization_id_date_idx`(`organization_id`, `date`),
    PRIMARY KEY (`organization_id`, `user_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stats_dirty_days` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `date` DATE NOT NULL,
    `marked_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stats_dirty_days_marked_at_idx`(`marked_at`),
    PRIMARY KEY (`organization_id`, `user_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_jobs` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `requested_by_id` CHAR(36) NOT NULL,
    `type` VARCHAR(48) NOT NULL,
    `format` VARCHAR(8) NOT NULL,
    `params` JSON NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'QUEUED',
    `row_count` INTEGER NULL,
    `storage_key` VARCHAR(300) NULL,
    `file_name` VARCHAR(200) NULL,
    `size_bytes` INTEGER NULL,
    `error` VARCHAR(500) NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `report_jobs_organization_id_requested_by_id_created_at_idx`(`organization_id`, `requested_by_id`, `created_at`),
    INDEX `report_jobs_status_expires_at_idx`(`status`, `expires_at`),
    UNIQUE INDEX `report_jobs_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `daily_member_stats` ADD CONSTRAINT `daily_member_stats_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `report_jobs` ADD CONSTRAINT `report_jobs_organization_id_requested_by_id_fkey` FOREIGN KEY (`organization_id`, `requested_by_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Activity events are a record of what happened: never edited (retention removes whole months).
CREATE TRIGGER `activity_events_block_update` BEFORE UPDATE ON `activity_events`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'activity_events is append-only';
