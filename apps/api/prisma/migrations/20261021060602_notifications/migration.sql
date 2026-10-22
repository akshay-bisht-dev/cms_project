-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `recipient_user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` VARCHAR(1000) NULL,
    `link` VARCHAR(500) NULL,
    `subject_type` VARCHAR(64) NULL,
    `subject_id` CHAR(36) NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_organization_id_recipient_user_id_read_at_crea_idx`(`organization_id`, `recipient_user_id`, `read_at`, `created_at`),
    UNIQUE INDEX `notifications_organization_id_recipient_user_id_dedupe_key_key`(`organization_id`, `recipient_user_id`, `dedupe_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `in_app` BOOLEAN NOT NULL DEFAULT true,
    `email` BOOLEAN NOT NULL DEFAULT false,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`organization_id`, `user_id`, `type`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_organization_id_recipient_user_id_fkey` FOREIGN KEY (`organization_id`, `recipient_user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;
