-- CreateTable
CREATE TABLE `capture_policies` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `scope_level` ENUM('ORG', 'TEAM', 'MEMBER') NOT NULL,
    `org_singleton` CHAR(3) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `current_version_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `capture_policies_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `capture_policies_organization_id_org_singleton_key`(`organization_id`, `org_singleton`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `monitoring_policy_versions` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `policy_id` CHAR(36) NOT NULL,
    `version_no` INTEGER NOT NULL,
    `capture_enabled` BOOLEAN NOT NULL,
    `interval_s` INTEGER NOT NULL,
    `min_interval_s` INTEGER NOT NULL,
    `max_interval_s` INTEGER NOT NULL,
    `blur` BOOLEAN NOT NULL DEFAULT false,
    `capture_mode` ENUM('ALL_SCREENS', 'ACTIVE_SCREEN') NOT NULL DEFAULT 'ACTIVE_SCREEN',
    `excluded_apps` JSON NOT NULL,
    `idle_detection_enabled` BOOLEAN NOT NULL DEFAULT false,
    `retention_days` INTEGER NOT NULL,
    `notice_text` TEXT NOT NULL,
    `notice_hash` CHAR(64) NOT NULL,
    `published_by_id` CHAR(36) NOT NULL,
    `published_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `monitoring_policy_versions_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `monitoring_policy_versions_policy_id_version_no_key`(`policy_id`, `version_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `capture_policy_assignments` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `policy_id` CHAR(36) NOT NULL,
    `target_type` ENUM('TEAM', 'MEMBER') NOT NULL,
    `target_id` CHAR(36) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `capture_policy_assignments_organization_id_target_type_targe_idx`(`organization_id`, `target_type`, `target_id`),
    UNIQUE INDEX `capture_policy_assignments_organization_id_target_type_targe_key`(`organization_id`, `target_type`, `target_id`, `policy_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `monitoring_consent_records` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `policy_version_id` CHAR(36) NOT NULL,
    `action` ENUM('ACKNOWLEDGED', 'WITHDRAWN') NOT NULL,
    `notice_hash` CHAR(64) NOT NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `monitoring_consent_records_organization_id_user_id_created_a_idx`(`organization_id`, `user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_pairing_codes` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_pairing_codes_code_hash_key`(`code_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `desktop_agents` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `device_name` VARCHAR(120) NOT NULL,
    `os` VARCHAR(32) NOT NULL,
    `os_version` VARCHAR(64) NULL,
    `agent_version` VARCHAR(32) NULL,
    `public_key` VARCHAR(128) NOT NULL,
    `status` ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `last_nonce_hash` CHAR(64) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `last_state` JSON NULL,
    `registered_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,
    `revoked_by_id` CHAR(36) NULL,

    INDEX `desktop_agents_organization_id_user_id_status_idx`(`organization_id`, `user_id`, `status`),
    UNIQUE INDEX `desktop_agents_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `screenshots` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `agent_id` CHAR(36) NOT NULL,
    `work_session_id` CHAR(36) NULL,
    `project_id` CHAR(36) NULL,
    `task_id` CHAR(36) NULL,
    `policy_version_id` CHAR(36) NOT NULL,
    `client_capture_id` CHAR(36) NOT NULL,
    `captured_at` DATETIME(3) NOT NULL,
    `uploaded_at` DATETIME(3) NULL,
    `storage_key` VARCHAR(300) NULL,
    `thumb_key` VARCHAR(300) NULL,
    `mime_type` VARCHAR(32) NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `size_bytes` INTEGER NULL,
    `sha256` VARCHAR(64) NULL,
    `status` ENUM('PENDING_UPLOAD', 'UPLOADED', 'READY', 'FAILED', 'REJECTED', 'DELETED') NOT NULL DEFAULT 'PENDING_UPLOAD',
    `failure_code` VARCHAR(48) NULL,
    `retention_expires_at` DATETIME(3) NULL,
    `legal_hold` BOOLEAN NOT NULL DEFAULT false,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `screenshots_organization_id_user_id_captured_at_idx`(`organization_id`, `user_id`, `captured_at`),
    INDEX `screenshots_organization_id_project_id_captured_at_idx`(`organization_id`, `project_id`, `captured_at`),
    INDEX `screenshots_status_retention_expires_at_idx`(`status`, `retention_expires_at`),
    INDEX `screenshots_status_created_at_idx`(`status`, `created_at`),
    UNIQUE INDEX `screenshots_organization_id_id_key`(`organization_id`, `id`),
    UNIQUE INDEX `screenshots_organization_id_agent_id_client_capture_id_key`(`organization_id`, `agent_id`, `client_capture_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `screenshot_access_logs` (
    `id` CHAR(36) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `organization_id` CHAR(36) NOT NULL,
    `screenshot_id` CHAR(36) NOT NULL,
    `actor_id` CHAR(36) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `ip` VARCHAR(45) NULL,

    INDEX `screenshot_access_logs_organization_id_screenshot_id_at_idx`(`organization_id`, `screenshot_id`, `at`),
    INDEX `screenshot_access_logs_organization_id_actor_id_at_idx`(`organization_id`, `actor_id`, `at`),
    PRIMARY KEY (`id`, `at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `screenshot_deletion_logs` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `screenshot_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `captured_at` DATETIME(3) NOT NULL,
    `actor_id` CHAR(36) NULL,
    `reason` VARCHAR(16) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `screenshot_deletion_logs_organization_id_created_at_idx`(`organization_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legal_holds` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `created_by_id` CHAR(36) NOT NULL,
    `released_at` DATETIME(3) NULL,
    `released_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `legal_holds_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legal_hold_targets` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `hold_id` CHAR(36) NOT NULL,
    `target_type` ENUM('MEMBER', 'PROJECT') NOT NULL,
    `target_id` CHAR(36) NOT NULL,
    `from_date` DATE NULL,
    `to_date` DATE NULL,

    INDEX `legal_hold_targets_organization_id_target_type_target_id_idx`(`organization_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `capture_policies` ADD CONSTRAINT `capture_policies_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `monitoring_policy_versions` ADD CONSTRAINT `monitoring_policy_versions_organization_id_policy_id_fkey` FOREIGN KEY (`organization_id`, `policy_id`) REFERENCES `capture_policies`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `capture_policy_assignments` ADD CONSTRAINT `capture_policy_assignments_organization_id_policy_id_fkey` FOREIGN KEY (`organization_id`, `policy_id`) REFERENCES `capture_policies`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `monitoring_consent_records` ADD CONSTRAINT `monitoring_consent_records_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `monitoring_consent_records` ADD CONSTRAINT `monitoring_consent_records_organization_id_policy_version_i_fkey` FOREIGN KEY (`organization_id`, `policy_version_id`) REFERENCES `monitoring_policy_versions`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_pairing_codes` ADD CONSTRAINT `agent_pairing_codes_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `desktop_agents` ADD CONSTRAINT `desktop_agents_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `screenshots` ADD CONSTRAINT `screenshots_organization_id_user_id_fkey` FOREIGN KEY (`organization_id`, `user_id`) REFERENCES `organization_members`(`organization_id`, `user_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `screenshots` ADD CONSTRAINT `screenshots_organization_id_agent_id_fkey` FOREIGN KEY (`organization_id`, `agent_id`) REFERENCES `desktop_agents`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `screenshots` ADD CONSTRAINT `screenshots_organization_id_policy_version_id_fkey` FOREIGN KEY (`organization_id`, `policy_version_id`) REFERENCES `monitoring_policy_versions`(`organization_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `legal_hold_targets` ADD CONSTRAINT `legal_hold_targets_organization_id_hold_id_fkey` FOREIGN KEY (`organization_id`, `hold_id`) REFERENCES `legal_holds`(`organization_id`, `id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Consent history and published policy versions are immutable (docs/screenshot-monitoring.md §4).
CREATE TRIGGER `monitoring_consent_records_block_update` BEFORE UPDATE ON `monitoring_consent_records`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_consent_records is append-only';

CREATE TRIGGER `monitoring_consent_records_block_delete` BEFORE DELETE ON `monitoring_consent_records`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_consent_records is append-only';

CREATE TRIGGER `monitoring_policy_versions_block_update` BEFORE UPDATE ON `monitoring_policy_versions`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'monitoring_policy_versions is immutable';

CREATE TRIGGER `screenshot_access_logs_block_update` BEFORE UPDATE ON `screenshot_access_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'screenshot_access_logs is append-only';

CREATE TRIGGER `screenshot_deletion_logs_block_update` BEFORE UPDATE ON `screenshot_deletion_logs`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'screenshot_deletion_logs is append-only';
