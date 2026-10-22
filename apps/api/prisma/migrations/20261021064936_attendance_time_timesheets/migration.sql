-- CreateTable
CREATE TABLE `work_schedules` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` ENUM('FIXED', 'FLEXIBLE') NOT NULL DEFAULT 'FIXED',
    `time_zone` VARCHAR(64) NULL,
    `days` JSON NOT NULL,
    `required_minutes_per_day` SMALLINT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `work_schedules_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `work_schedules_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_assignments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `schedule_id` CHAR(36) NOT NULL,
    `target_type` ENUM('DEPARTMENT', 'TEAM', 'MEMBER') NOT NULL,
    `target_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `schedule_assignments_organization_id_target_type_target_id_key`(`organization_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `date` DATE NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `is_half_day` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `holidays_organization_id_date_key`(`organization_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_work_states` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `state` ENUM('OFF', 'WORKING', 'ON_BREAK') NOT NULL DEFAULT 'OFF',
    `work_session_id` CHAR(36) NULL,
    `break_session_id` CHAR(36) NULL,
    `timer_state` ENUM('NONE', 'RUNNING', 'PAUSED') NOT NULL DEFAULT 'NONE',
    `time_entry_id` CHAR(36) NULL,
    `timer_context` JSON NULL,
    `last_activity_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `member_work_states_organization_id_state_idx`(`organization_id`, `state`),
    PRIMARY KEY (`organization_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `work_date` DATE NOT NULL,
    `status` ENUM('PRESENT', 'ABSENT', 'HOLIDAY') NOT NULL DEFAULT 'PRESENT',
    `time_zone` VARCHAR(64) NOT NULL,
    `first_in_at` DATETIME(3) NULL,
    `last_out_at` DATETIME(3) NULL,
    `worked_s` INTEGER NOT NULL DEFAULT 0,
    `break_s` INTEGER NOT NULL DEFAULT 0,
    `late_by_s` INTEGER NOT NULL DEFAULT 0,
    `early_by_s` INTEGER NOT NULL DEFAULT 0,
    `overtime_s` INTEGER NOT NULL DEFAULT 0,
    `flags` JSON NOT NULL,
    `schedule_snapshot` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_records_organization_id_work_date_status_idx`(`organization_id`, `work_date`, `status`),
    UNIQUE INDEX `attendance_records_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `attendance_records_organization_id_user_id_work_date_key`(`organization_id`, `user_id`, `work_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_sessions` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `attendance_record_id` CHAR(36) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `end_reason` ENUM('CLOCK_OUT', 'AUTO_CLOSED', 'CORRECTION') NULL,
    `source` ENUM('WEB', 'AGENT', 'CORRECTION') NOT NULL DEFAULT 'WEB',
    `note` VARCHAR(280) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `work_sessions_organization_id_user_id_started_at_idx`(`organization_id`, `user_id`, `started_at`),
    INDEX `work_sessions_organization_id_ended_at_idx`(`organization_id`, `ended_at`),
    UNIQUE INDEX `work_sessions_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `break_sessions` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `work_session_id` CHAR(36) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `break_sessions_organization_id_work_session_id_idx`(`organization_id`, `work_session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_corrections` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `attendance_record_id` CHAR(36) NULL,
    `work_date` DATE NOT NULL,
    `kind` ENUM('ADD', 'MODIFY', 'DELETE') NOT NULL,
    `work_session_id` CHAR(36) NULL,
    `proposed_start_at` DATETIME(3) NULL,
    `proposed_end_at` DATETIME(3) NULL,
    `original` JSON NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_id` CHAR(36) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `review_comment` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `attendance_corrections_organization_id_status_created_at_idx`(`organization_id`, `status`, `created_at`),
    INDEX `attendance_corrections_organization_id_user_id_created_at_idx`(`organization_id`, `user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `time_entries` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `work_session_id` CHAR(36) NULL,
    `project_id` CHAR(36) NULL,
    `task_id` CHAR(36) NULL,
    `description` VARCHAR(500) NULL,
    `is_billable` BOOLEAN NOT NULL DEFAULT false,
    `started_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `duration_s` INTEGER NOT NULL DEFAULT 0,
    `source` ENUM('TIMER', 'MANUAL') NOT NULL DEFAULT 'TIMER',
    `locked_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `time_entries_organization_id_user_id_started_at_idx`(`organization_id`, `user_id`, `started_at`),
    INDEX `time_entries_organization_id_project_id_started_at_idx`(`organization_id`, `project_id`, `started_at`),
    UNIQUE INDEX `time_entries_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `time_entry_revisions` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `time_entry_id` CHAR(36) NOT NULL,
    `revision_no` INTEGER NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `changed_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `time_entry_revisions_time_entry_id_revision_no_key`(`time_entry_id`, `revision_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `timesheets` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    `total_s` INTEGER NOT NULL DEFAULT 0,
    `billable_s` INTEGER NOT NULL DEFAULT 0,
    `submitted_at` DATETIME(3) NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by_id` CHAR(36) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `timesheets_organization_id_status_period_start_idx`(`organization_id`, `status`, `period_start`),
    UNIQUE INDEX `timesheets_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `timesheets_organization_id_user_id_period_start_key`(`organization_id`, `user_id`, `period_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `timesheet_entries` (
    `organization_id` CHAR(36) NOT NULL,
    `timesheet_id` CHAR(36) NOT NULL,
    `time_entry_id` CHAR(36) NOT NULL,

    UNIQUE INDEX `timesheet_entries_organization_id_time_entry_id_key`(`organization_id`, `time_entry_id`),
    PRIMARY KEY (`timesheet_id`, `time_entry_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `timesheet_approvals` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `timesheet_id` CHAR(36) NOT NULL,
    `action` ENUM('SUBMIT', 'APPROVE', 'REJECT', 'REOPEN') NOT NULL,
    `actor_id` CHAR(36) NOT NULL,
    `comment` VARCHAR(2000) NULL,
    `snapshot` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `timesheet_approvals_organization_id_timesheet_id_created_at_idx`(`organization_id`, `timesheet_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `work_schedules` ADD CONSTRAINT `work_schedules_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_assignments` ADD CONSTRAINT `schedule_assignments_organization_id_schedule_id_fkey` FOREIGN KEY (`organization_id`, `schedule_id`) REFERENCES `work_schedules`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `holidays` ADD CONSTRAINT `holidays_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_work_states` ADD CONSTRAINT `member_work_states_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `work_sessions` ADD CONSTRAINT `work_sessions_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `work_sessions` ADD CONSTRAINT `work_sessions_organization_id_attendance_record_id_fkey` FOREIGN KEY (`organization_id`, `attendance_record_id`) REFERENCES `attendance_records`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `break_sessions` ADD CONSTRAINT `break_sessions_organization_id_work_session_id_fkey` FOREIGN KEY (`organization_id`, `work_session_id`) REFERENCES `work_sessions`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `attendance_corrections` ADD CONSTRAINT `attendance_corrections_organization_id_attendance_record_id_fkey` FOREIGN KEY (`organization_id`, `attendance_record_id`) REFERENCES `attendance_records`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_organization_id_work_session_id_fkey` FOREIGN KEY (`organization_id`, `work_session_id`) REFERENCES `work_sessions`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `time_entry_revisions` ADD CONSTRAINT `time_entry_revisions_organization_id_time_entry_id_fkey` FOREIGN KEY (`organization_id`, `time_entry_id`) REFERENCES `time_entries`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `timesheets` ADD CONSTRAINT `timesheets_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_organization_id_timesheet_id_fkey` FOREIGN KEY (`organization_id`, `timesheet_id`) REFERENCES `timesheets`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_organization_id_time_entry_id_fkey` FOREIGN KEY (`organization_id`, `time_entry_id`) REFERENCES `time_entries`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `timesheet_approvals` ADD CONSTRAINT `timesheet_approvals_organization_id_timesheet_id_fkey` FOREIGN KEY (`organization_id`, `timesheet_id`) REFERENCES `timesheets`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Timesheet decisions are an immutable history (docs/database-design.md §7).
CREATE TRIGGER `timesheet_approvals_block_update` BEFORE UPDATE ON `timesheet_approvals`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'timesheet_approvals is append-only';

CREATE TRIGGER `timesheet_approvals_block_delete` BEFORE DELETE ON `timesheet_approvals`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'timesheet_approvals is append-only';
