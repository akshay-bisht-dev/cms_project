-- CreateTable
CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `time_zone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `base_currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `locale` VARCHAR(16) NOT NULL DEFAULT 'en-US',
    `week_start` TINYINT NOT NULL DEFAULT 1,
    `brand_color` VARCHAR(9) NULL,
    `status` ENUM('TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'TRIAL',
    `seat_limit` INTEGER NULL,
    `storage_limit_bytes` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `email_verified_at` DATETIME(3) NULL,
    `password_hash` VARCHAR(255) NULL,
    `name` VARCHAR(160) NOT NULL,
    `status` ENUM('ACTIVE', 'LOCKED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `failed_login_count` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_members` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `member_type` ENUM('EMPLOYEE', 'CLIENT') NOT NULL DEFAULT 'EMPLOYEE',
    `status` ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ARCHIVED') NOT NULL DEFAULT 'INVITED',
    `joined_at` DATETIME(3) NULL,
    `deactivated_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `organization_members_organization_id_status_idx`(`organization_id`, `status`),
    INDEX `organization_members_user_id_idx`(`user_id`),
    UNIQUE INDEX `organization_members_organization_id_user_id_key`(`organization_id`, `user_id`),
    UNIQUE INDEX `organization_members_organization_id_id_key`(`organization_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `active_organization_id` CHAR(36) NULL,
    `token_hash` CHAR(64) NOT NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `device_label` VARCHAR(120) NULL,
    `mfa_verified_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoke_reason` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_sessions_token_hash_key`(`token_hash`),
    INDEX `user_sessions_user_id_revoked_at_idx`(`user_id`, `revoked_at`),
    INDEX `user_sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `organization_id` CHAR(36) NULL,
    `actor_type` ENUM('USER', 'AGENT', 'SYSTEM', 'API_KEY', 'SUPPORT') NOT NULL,
    `actor_id` CHAR(36) NULL,
    `action` VARCHAR(96) NOT NULL,
    `target_type` VARCHAR(64) NULL,
    `target_id` CHAR(36) NULL,
    `diff` JSON NULL,
    `ip` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `request_id` VARCHAR(128) NULL,

    INDEX `audit_logs_organization_id_at_idx`(`organization_id`, `at`),
    INDEX `audit_logs_organization_id_target_type_target_id_idx`(`organization_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`, `at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outbox_events` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NULL,
    `type` VARCHAR(96) NOT NULL,
    `payload` JSON NOT NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `published_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `outbox_events_dedupe_key_key`(`dedupe_key`),
    INDEX `outbox_events_published_at_available_at_idx`(`published_at`, `available_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_keys` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `method_path` VARCHAR(255) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `response_status` SMALLINT NULL,
    `response_body` JSON NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idempotency_keys_expires_at_idx`(`expires_at`),
    UNIQUE INDEX `idempotency_keys_organization_id_user_id_key_key`(`organization_id`, `user_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `background_job_records` (
    `id` CHAR(36) NOT NULL,
    `queue` VARCHAR(64) NOT NULL,
    `job_id` VARCHAR(128) NULL,
    `name` VARCHAR(96) NOT NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `attempts` INTEGER NOT NULL DEFAULT 1,
    `last_error` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    UNIQUE INDEX `background_job_records_queue_idempotency_key_key`(`queue`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_active_organization_id_fkey` FOREIGN KEY (`active_organization_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
