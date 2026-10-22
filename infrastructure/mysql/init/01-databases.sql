-- Runs once when the local MySQL container is first created.
-- Local/dev only: production users and grants are provisioned by the release process (docs/deployment.md).
CREATE DATABASE IF NOT EXISTS orbit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS orbit_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS orbit_e2e_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS orbit_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'orbit_app'@'%' IDENTIFIED BY 'orbit_app_dev';
-- In development the app user also runs migrations, so it needs DDL on its own schemas.
GRANT ALL PRIVILEGES ON orbit.* TO 'orbit_app'@'%';
GRANT ALL PRIVILEGES ON orbit_test.* TO 'orbit_app'@'%';
GRANT ALL PRIVILEGES ON orbit_e2e_test.* TO 'orbit_app'@'%';
FLUSH PRIVILEGES;
