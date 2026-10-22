-- CreateTable
CREATE TABLE `projects` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `client_id` CHAR(36) NULL,
    `manager_user_id` CHAR(36) NULL,
    `status` ENUM('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PLANNED',
    `priority` ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') NOT NULL DEFAULT 'MEDIUM',
    `visibility` ENUM('PRIVATE', 'ORG') NOT NULL DEFAULT 'PRIVATE',
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `deadline` DATE NULL,
    `budget_amount` DECIMAL(19, 4) NULL,
    `budget_currency` CHAR(3) NULL,
    `estimated_s` INTEGER NULL,
    `is_billable_default` BOOLEAN NOT NULL DEFAULT true,
    `next_task_number` INTEGER NOT NULL DEFAULT 1,
    `closed_at` DATETIME(3) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `projects_organization_id_status_archived_at_idx`(`organization_id`, `status`, `archived_at`),
    INDEX `projects_organization_id_manager_user_id_idx`(`organization_id`, `manager_user_id`),
    UNIQUE INDEX `projects_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `projects_organization_id_code_key`(`organization_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_members` (
    `organization_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `role` ENUM('MANAGER', 'MEMBER', 'VIEWER') NOT NULL DEFAULT 'MEMBER',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `project_members_organization_id_user_id_idx`(`organization_id`, `user_id`),
    PRIMARY KEY (`project_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `milestones` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `due_date` DATE NULL,
    `completed_at` DATETIME(3) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `milestones_organization_id_project_id_due_date_idx`(`organization_id`, `project_id`, `due_date`),
    UNIQUE INDEX `milestones_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_statuses` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `category` ENUM('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED') NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `task_statuses_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `task_statuses_project_id_name_key`(`project_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tasks` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `parent_id` CHAR(36) NULL,
    `milestone_id` CHAR(36) NULL,
    `status_id` CHAR(36) NOT NULL,
    `title` VARCHAR(300) NOT NULL,
    `description` TEXT NULL,
    `priority` ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT') NOT NULL DEFAULT 'MEDIUM',
    `start_date` DATE NULL,
    `due_date` DATE NULL,
    `estimated_s` INTEGER NULL,
    `recurrence` JSON NULL,
    `sort` DOUBLE NOT NULL DEFAULT 0,
    `completed_at` DATETIME(3) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_by_id` CHAR(36) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `tasks_organization_id_project_id_status_id_sort_idx`(`organization_id`, `project_id`, `status_id`, `sort`),
    INDEX `tasks_organization_id_due_date_idx`(`organization_id`, `due_date`),
    INDEX `tasks_organization_id_parent_id_idx`(`organization_id`, `parent_id`),
    UNIQUE INDEX `tasks_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `tasks_project_id_number_key`(`project_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_assignees` (
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_assignees_organization_id_user_id_idx`(`organization_id`, `user_id`),
    PRIMARY KEY (`task_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_checklist_items` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `done_at` DATETIME(3) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    INDEX `task_checklist_items_organization_id_task_id_idx`(`organization_id`, `task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `labels` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `color` VARCHAR(9) NOT NULL DEFAULT '#6D4AE0',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `labels_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `labels_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_labels` (
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `label_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`task_id`, `label_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_comments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `author_id` CHAR(36) NOT NULL,
    `body` TEXT NOT NULL,
    `edited_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_comments_organization_id_task_id_created_at_idx`(`organization_id`, `task_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_dependencies` (
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `depends_on_task_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_dependencies_organization_id_depends_on_task_id_idx`(`organization_id`, `depends_on_task_id`),
    PRIMARY KEY (`task_id`, `depends_on_task_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_events` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `actor_id` CHAR(36) NULL,
    `type` VARCHAR(48) NOT NULL,
    `data` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_events_organization_id_task_id_created_at_idx`(`organization_id`, `task_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_objects` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `storage_key` VARCHAR(300) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(127) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `purpose` VARCHAR(48) NOT NULL,
    `status` ENUM('PENDING', 'READY', 'DELETED') NOT NULL DEFAULT 'PENDING',
    `uploaded_by_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `file_objects_storage_key_key`(`storage_key`),
    INDEX `file_objects_organization_id_status_created_at_idx`(`organization_id`, `status`, `created_at`),
    UNIQUE INDEX `file_objects_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_attachments` (
    `organization_id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `file_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`task_id`, `file_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `calendar_events` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `start_at` DATETIME(3) NOT NULL,
    `end_at` DATETIME(3) NOT NULL,
    `all_day` BOOLEAN NOT NULL DEFAULT false,
    `location` VARCHAR(200) NULL,
    `project_id` CHAR(36) NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `cancelled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `calendar_events_organization_id_start_at_idx`(`organization_id`, `start_at`),
    UNIQUE INDEX `calendar_events_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `calendar_event_attendees` (
    `organization_id` CHAR(36) NOT NULL,
    `event_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,

    INDEX `calendar_event_attendees_organization_id_user_id_idx`(`organization_id`, `user_id`),
    PRIMARY KEY (`event_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `time_entries_organization_id_task_id_idx` ON `time_entries`(`organization_id`, `task_id`);

-- AddForeignKey
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_organization_id_project_id_fkey` FOREIGN KEY (`organization_id`, `project_id`) REFERENCES `projects`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_organization_id_manager_user_id_fkey` FOREIGN KEY (`organization_id`, `manager_user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `project_members` ADD CONSTRAINT `project_members_organization_id_project_id_fkey` FOREIGN KEY (`organization_id`, `project_id`) REFERENCES `projects`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `project_members` ADD CONSTRAINT `project_members_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `milestones` ADD CONSTRAINT `milestones_organization_id_project_id_fkey` FOREIGN KEY (`organization_id`, `project_id`) REFERENCES `projects`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_statuses` ADD CONSTRAINT `task_statuses_organization_id_project_id_fkey` FOREIGN KEY (`organization_id`, `project_id`) REFERENCES `projects`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_organization_id_project_id_fkey` FOREIGN KEY (`organization_id`, `project_id`) REFERENCES `projects`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_organization_id_parent_id_fkey` FOREIGN KEY (`organization_id`, `parent_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_organization_id_milestone_id_fkey` FOREIGN KEY (`organization_id`, `milestone_id`) REFERENCES `milestones`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_organization_id_status_id_fkey` FOREIGN KEY (`organization_id`, `status_id`) REFERENCES `task_statuses`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_assignees` ADD CONSTRAINT `task_assignees_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_assignees` ADD CONSTRAINT `task_assignees_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_checklist_items` ADD CONSTRAINT `task_checklist_items_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `labels` ADD CONSTRAINT `labels_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_organization_id_label_id_fkey` FOREIGN KEY (`organization_id`, `label_id`) REFERENCES `labels`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_dependencies` ADD CONSTRAINT `task_dependencies_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_dependencies` ADD CONSTRAINT `task_dependencies_organization_id_depends_on_task_id_fkey` FOREIGN KEY (`organization_id`, `depends_on_task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_events` ADD CONSTRAINT `task_events_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_attachments` ADD CONSTRAINT `task_attachments_organization_id_task_id_fkey` FOREIGN KEY (`organization_id`, `task_id`) REFERENCES `tasks`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_attachments` ADD CONSTRAINT `task_attachments_organization_id_file_id_fkey` FOREIGN KEY (`organization_id`, `file_id`) REFERENCES `file_objects`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `calendar_event_attendees` ADD CONSTRAINT `calendar_event_attendees_organization_id_event_id_fkey` FOREIGN KEY (`organization_id`, `event_id`) REFERENCES `calendar_events`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `calendar_event_attendees` ADD CONSTRAINT `calendar_event_attendees_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;
