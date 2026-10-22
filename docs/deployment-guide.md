# Deployment guide

How to run Orbit in production. The architecture and its reasoning are in [deployment.md](deployment.md),
every setting is in [environment.md](environment.md), and the release procedure is in
[release-checklist.md](release-checklist.md).

> **Verification status.** Images, compose files and manifests are checked statically on every lint run
> (`scripts/check-deploy.mjs`: YAML validity, non-root, read-only filesystems, dropped capabilities,
> resources, probes, pinned images, no inline secrets). CI builds and scans every image and runs the
> real Redis/S3 suite against Docker Compose. Neither a production compose host nor a Kubernetes
> cluster has been brought up during development: do that on staging before the first production release.

## Images
One Dockerfile for the API side, with several targets, plus one for the web app:

| Image | Built from | Runs |
|---|---|---|
| `orbit-api` | `api.Dockerfile --target api` | HTTP API and Socket.IO (Node 24 Alpine, user `node`) |
| `orbit-worker` | `--target worker` | Queues, schedules, outbox relay |
| `orbit-migrate` | `--target migrate` | `prisma migrate deploy` (release job only, never at app start) |
| `orbit-ops` | `--target ops` | Backups, restore checks, partition maintenance, user provisioning (official `mysql:8.4` base for matching client tools, plus Node and `age`) |
| `orbit-web` | `web.Dockerfile` | Next.js standalone server |

The release workflow pushes `:<version>` and `:sha-<commit>` tags with an SBOM and provenance, and signs
each digest with cosign (keyless). Verify before deploying by hand:
`cosign verify ghcr.io/<org>/<repo>/orbit-api:1.4.0 --certificate-identity-regexp 'https://github.com/<org>/<repo>/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

## Prerequisites (both options)
1. **MySQL 8.4** (managed recommended, with point-in-time recovery) and `log_bin_trust_function_creators=1`
   (migrations create triggers).
2. **Redis 7** with persistence (AOF) and a password; TLS (`rediss://`) when it is not on a private network.
3. **Object storage:** buckets `files`, `captures`, `archive` and `backups`, all private, with versioning on
   `files` and object lock on `backups`. A CORS rule on `files` and `captures` lets the web origin `PUT`
   and `GET` (presigned uploads).
4. **Database users:** run once per environment with an admin account (passwords from your secret manager):
   ```bash
   DATABASE_ADMIN_URL=mysql://admin:…@db:3306/orbit DB_REQUIRE_TLS=true \
   DB_APP_PASSWORD=… DB_MIGRATE_PASSWORD=… DB_MAINTENANCE_PASSWORD=… DB_BACKUP_PASSWORD=… \
     docker run --rm -e DATABASE_ADMIN_URL -e DB_REQUIRE_TLS -e DB_APP_PASSWORD -e DB_MIGRATE_PASSWORD \
       -e DB_MAINTENANCE_PASSWORD -e DB_BACKUP_PASSWORD orbit-ops:<version> node scripts/provision-db-users.js
   ```
   The app user gets data reads and writes only (the full browser suite passes with exactly these grants),
   the migrate user DDL, the maintenance user `ALTER/DROP` on the four partitioned tables, and the backup
   user read-only.
5. **Secrets:** generate `SESSION_SECRET`, `CSRF_SECRET` (48 random bytes each) and `FIELD_ENCRYPTION_KEYS`
   (`k1:` + 32 random bytes, base64). Keep them in the secret manager.
6. **DNS and TLS** for your domain.

## Option A: single host with Docker Compose
For small installations (one VM, 4–8 vCPU, 16–32 GB), ideally with managed MySQL and Redis.

```bash
sudo install -d -m 0700 /etc/orbit /var/backups/orbit && sudo chown 999:999 /var/backups/orbit
sudo install -m 0600 orbit.env web.env migrate.env ops.env /etc/orbit/   # see docs/environment.md
export ORBIT_REGISTRY=ghcr.io/<org>/<repo> ORBIT_VERSION=1.4.0 ORBIT_DOMAIN=orbit.example.com

# TLS certificate (once; renew with a timer running "certbot renew" and "docker compose exec nginx nginx -s reload")
sudo certbot certonly --webroot -w /var/www/certbot -d "$ORBIT_DOMAIN"   # serve the challenge path first

docker compose -f docker-compose.prod.yml --profile release run --rm migrate
docker compose -f docker-compose.prod.yml up -d
curl -fsS "https://$ORBIT_DOMAIN/api/v1/health/ready"
```
`docker-compose.prod.yml` publishes only Nginx (80/443). Every service runs read-only, with all
capabilities dropped and memory limits; self-hosted MySQL and Redis (`--profile selfhosted`) sit on a
network with no route out. Nginx (`infrastructure/nginx/production/orbit.conf.template`) terminates
TLS 1.2/1.3 with the Mozilla intermediate ciphers, OCSP stapling and HSTS, and adds edge rate limits
(5 r/s per IP on sign-in, reset and MFA; 30 r/s on the API).

Schedule the ops jobs with systemd timers (see [operations.md](operations.md#scheduled-work)).

## Option B: Kubernetes
```bash
kubectl apply -k infrastructure/k8s/overlays/production   # after setting image tags and host in the overlay
```
- **Namespace:** `orbit`, with Pod Security Admission `restricted` enforced.
- **Workloads:** Deployments `api` (2–10, HPA on CPU), `web` (2–6) and `worker` (2), each with a
  PodDisruptionBudget. Everything runs non-root with a read-only root filesystem, all capabilities
  dropped, the default seccomp profile and no service-account token.
- **Ingress:** ingress-nginx + cert-manager (`letsencrypt` ClusterIssuer); `/api` and `/socket.io` go to
  the API, the rest to web.
- **NetworkPolicies:** default-deny ingress; allowed are the ingress controller, web → API, and
  Prometheus on 9464. Egress stays open for webhooks; the API's SSRF guard blocks private addresses.
- **CronJobs:** `mysql-backup`, `mysql-restore-verify`, `partition-maintenance`, each with its own Secret.
- **Release:** the migration is a separate Job (`infrastructure/k8s/release/migrate-job.yaml`) run by
  the release pipeline, never on every apply.
- **Secrets:** create `orbit-secrets`, `orbit-migrate`, `orbit-backup`, `orbit-restore`,
  `orbit-maintenance` and `orbit-age-identity` with your secret manager. The shapes are in
  `infrastructure/k8s/secrets.example.yaml`; never commit real values (the lint check rejects a committed
  Secret).
- **Prometheus:** load `infrastructure/monitoring/alert-rules.yml`; scrape pods annotated
  `prometheus.io/scrape`.

## Releasing
Tag `vX.Y.Z`. `.github/workflows/release.yml` then:
1. runs the full CI;
2. builds, pushes and signs the images;
3. deploys to staging and smoke-tests it;
4. after approval, deploys to production with `infrastructure/scripts/deploy.sh`: a fresh backup, the
   migration Job, the rollout (undone automatically if any Deployment fails to become ready) and a
   smoke test.

Migrations are expand/contract, so the previous version keeps working on the new schema and a rollback
is `kubectl rollout undo`. Details and the manual checklist: [release-checklist.md](release-checklist.md).

## Desktop agent
`.github/workflows/agent-release.yml` builds the macOS DMG (signed with a Developer ID and notarized) and
the Windows NSIS installer (Authenticode) when the signing secrets are present, verifies the signatures,
and uploads the artifacts. Without certificates it produces artifacts marked `-UNSIGNED` that must not
be distributed. The Apple Developer ID and code-signing certificates have to be bought by the company.
