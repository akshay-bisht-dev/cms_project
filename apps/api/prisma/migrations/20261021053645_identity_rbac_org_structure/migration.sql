-- AlterTable
ALTER TABLE `user_sessions` ADD COLUMN `mfa_required` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `password_changed_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `organization_settings` (
    `organization_id` CHAR(36) NOT NULL,
    `data` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`organization_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_profiles` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `employee_code` VARCHAR(32) NULL,
    `designation` VARCHAR(120) NULL,
    `department_id` CHAR(36) NULL,
    `manager_user_id` CHAR(36) NULL,
    `employment_type` ENUM('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN') NULL,
    `joining_date` DATE NULL,
    `probation_end_date` DATE NULL,
    `notice_period_days` SMALLINT NULL,
    `last_working_date` DATE NULL,
    `work_location` VARCHAR(120) NULL,
    `time_zone` VARCHAR(64) NULL,
    `phone` VARCHAR(32) NULL,
    `personal_email_enc` TEXT NULL,
    `address_enc` TEXT NULL,
    `emergency_contact_enc` TEXT NULL,
    `skills` JSON NULL,
    `completion_pct` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employee_profiles_organization_id_department_id_idx`(`organization_id`, `department_id`),
    INDEX `employee_profiles_organization_id_manager_user_id_idx`(`organization_id`, `manager_user_id`),
    UNIQUE INDEX `employee_profiles_organization_id_user_id_key`(`organization_id`, `user_id`),
    UNIQUE INDEX `employee_profiles_organization_id_employee_code_key`(`organization_id`, `employee_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `profile_change_history` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `field` VARCHAR(64) NOT NULL,
    `old_value` TEXT NULL,
    `new_value` TEXT NULL,
    `changed_by_id` CHAR(36) NULL,
    `request_id` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `profile_change_history_organization_id_user_id_created_at_idx`(`organization_id`, `user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `manager_user_id` CHAR(36) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `departments_organization_id_parent_id_idx`(`organization_id`, `parent_id`),
    UNIQUE INDEX `departments_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `departments_organization_id_code_key`(`organization_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teams` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `department_id` CHAR(36) NULL,
    `lead_user_id` CHAR(36) NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `teams_organization_id_lead_user_id_idx`(`organization_id`, `lead_user_id`),
    UNIQUE INDEX `teams_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `teams_organization_id_name_key`(`organization_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `team_members` (
    `organization_id` CHAR(36) NOT NULL,
    `team_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `team_members_organization_id_user_id_idx`(`organization_id`, `user_id`),
    PRIMARY KEY (`team_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `key` VARCHAR(96) NOT NULL,
    `module` VARCHAR(48) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `allowed_scopes` JSON NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roles_organization_id_key_key`(`organization_id`, `key`),
    UNIQUE INDEX `roles_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `organization_id` CHAR(36) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `permission_key` VARCHAR(96) NOT NULL,
    `scope` ENUM('SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG') NOT NULL,

    INDEX `role_permissions_organization_id_idx`(`organization_id`),
    PRIMARY KEY (`role_id`, `permission_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_roles` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `member_roles_organization_id_role_id_idx`(`organization_id`, `role_id`),
    PRIMARY KEY (`organization_id`, `user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_permission_overrides` (
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `permission_key` VARCHAR(96) NOT NULL,
    `reason` VARCHAR(500) NULL,
    `created_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`organization_id`, `user_id`, `permission_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `accepted_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `invited_by_id` CHAR(36) NULL,
    `send_count` INTEGER NOT NULL DEFAULT 1,
    `last_sent_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `invitations_token_hash_key`(`token_hash`),
    INDEX `invitations_organization_id_email_idx`(`organization_id`, `email`),
    INDEX `invitations_organization_id_user_id_idx`(`organization_id`, `user_id`),
    UNIQUE INDEX `invitations_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_tokens` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `purpose` ENUM('VERIFY_EMAIL', 'RESET_PASSWORD') NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_tokens_token_hash_key`(`token_hash`),
    INDEX `auth_tokens_user_id_purpose_idx`(`user_id`, `purpose`),
    INDEX `auth_tokens_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mfa_settings` (
    `user_id` CHAR(36) NOT NULL,
    `secret_enc` TEXT NULL,
    `pending_secret_enc` TEXT NULL,
    `enabled_at` DATETIME(3) NULL,
    `recovery_code_hashes` JSON NULL,
    `last_used_step` BIGINT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_attempts` (
    `id` CHAR(36) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `email_hash` CHAR(64) NOT NULL,
    `ip` VARCHAR(45) NULL,
    `success` BOOLEAN NOT NULL,
    `reason` VARCHAR(32) NOT NULL,

    INDEX `login_attempts_email_hash_at_idx`(`email_hash`, `at`),
    INDEX `login_attempts_ip_at_idx`(`ip`, `at`),
    PRIMARY KEY (`id`, `at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `user_sessions_active_organization_id_user_id_idx` ON `user_sessions`(`active_organization_id`, `user_id`);

-- AddForeignKey
ALTER TABLE `organization_settings` ADD CONSTRAINT `organization_settings_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_profiles` ADD CONSTRAINT `employee_profiles_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employee_profiles` ADD CONSTRAINT `employee_profiles_organization_id_department_id_fkey` FOREIGN KEY (`organization_id`, `department_id`) REFERENCES `departments`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `employee_profiles` ADD CONSTRAINT `employee_profiles_organization_id_manager_user_id_fkey` FOREIGN KEY (`organization_id`, `manager_user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `profile_change_history` ADD CONSTRAINT `profile_change_history_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_organization_id_parent_id_fkey` FOREIGN KEY (`organization_id`, `parent_id`) REFERENCES `departments`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_organization_id_manager_user_id_fkey` FOREIGN KEY (`organization_id`, `manager_user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_organization_id_department_id_fkey` FOREIGN KEY (`organization_id`, `department_id`) REFERENCES `departments`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_organization_id_lead_user_id_fkey` FOREIGN KEY (`organization_id`, `lead_user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_organization_id_team_id_fkey` FOREIGN KEY (`organization_id`, `team_id`) REFERENCES `teams`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `roles` ADD CONSTRAINT `roles_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_organization_id_role_id_fkey` FOREIGN KEY (`organization_id`, `role_id`) REFERENCES `roles`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_key_fkey` FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_roles` ADD CONSTRAINT `member_roles_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `member_roles` ADD CONSTRAINT `member_roles_organization_id_role_id_fkey` FOREIGN KEY (`organization_id`, `role_id`) REFERENCES `roles`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `member_permission_overrides` ADD CONSTRAINT `member_permission_overrides_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `member_permission_overrides` ADD CONSTRAINT `member_permission_overrides_permission_key_fkey` FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `auth_tokens` ADD CONSTRAINT `auth_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mfa_settings` ADD CONSTRAINT `mfa_settings_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
