# Monorepo Folder Structure (JavaScript only)

The structure from the brief, plus the additions marked `+` (with a reason). The repo root
is this directory (`cms_project/`), which plays the role of `it-services-crm/`.

```
.
├── apps/
│   ├── web/                                  Next.js App Router (JSX)
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/ login/ forgot-password/ reset-password/ verify-email/ accept-invite/ register/
│   │   │   │   ├── (dashboard)/
│   │   │   │   │   ├── layout.jsx            server: fetch /auth/me, AppShell
│   │   │   │   │   ├── my-dashboard/ dashboard/ project-management/
│   │   │   │   │   ├── employees/[employeeId]/[[...tab]]/page.jsx
│   │   │   │   │   ├── departments/ teams/ projects/ tasks/ clients/ leads/ opportunities/ tickets/
│   │   │   │   │   ├── attendance/ time/ timesheets/ screenshots/ monitoring/ activity/ insights/
│   │   │   │   │   ├── reports/ leave/ calendar/ financials/ documents/ notifications/
│   │   │   │   │   ├── settings/ audit-logs/ account/
│   │   │   │   ├── (portal)/portal/          + client-user portal (separate layout, no sidebar)
│   │   │   │   ├── (platform)/platform/      + super-admin console
│   │   │   │   ├── layout.jsx  page.jsx  loading.jsx  error.jsx  not-found.jsx  global-error.jsx
│   │   │   ├── components/
│   │   │   │   ├── ui/                       shadcn (JSX; components.json "tsx": false)
│   │   │   │   ├── layout/                   AppShell, Sidebar, Topbar
│   │   │   │   ├── dashboard/ employees/ projects/ attendance/ screenshots/ data-tables/
│   │   │   │   └── common/                   + Can, StatusBadge, EmptyState, ErrorState, ConfirmDialog
│   │   │   ├── features/<domain>/            queries.js (TanStack hooks), components, forms
│   │   │   ├── hooks/                        useCan, useDebounce, useUrlState, useRealtime
│   │   │   ├── lib/                          query-client.js, socket.js, format.js (Intl, tz), permissions.js
│   │   │   ├── services/                     server-side fetch helpers (cookie forwarding)
│   │   │   ├── stores/                       zustand: ui-store.js, timer-store.js
│   │   │   ├── styles/globals.css            Tailwind v4 + tokens
│   │   │   └── middleware.js                 + cookie-presence redirect, CSP nonce
│   │   ├── tests/                            + vitest + RTL unit/component tests
│   │   ├── e2e/                              + Playwright specs (run against the compose stack)
│   │   ├── components.json  next.config.mjs  postcss.config.mjs  eslint.config.mjs
│   │   ├── vitest.config.mjs  playwright.config.mjs  jsconfig.json   (+ path aliases)
│   │   └── package.json
│   │
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.js                        build express app (no listen) — used by tests
│   │   │   ├── server.js                     HTTP + Socket.IO, graceful shutdown
│   │   │   ├── worker.js                     + BullMQ workers, schedulers, outbox relay
│   │   │   ├── config/                       env.js (zod-validated), logger.js, constants
│   │   │   ├── middleware/                   request-id, auth-session, auth-bearer, csrf, rate-limit,
│   │   │   │                                 tenant-context, validate, authorize, idempotency, error-handler
│   │   │   ├── routes/index.js               mounts module routers under /api/v1
│   │   │   ├── modules/<module>/
│   │   │   │   ├── <module>.routes.js        declarative route defs (schema, permission, flags)
│   │   │   │   ├── <module>.controller.js
│   │   │   │   ├── <module>.service.js
│   │   │   │   ├── <module>.repository.js
│   │   │   │   ├── <module>.schema.js        imports from @orbit/validation, adds API-only schemas
│   │   │   │   ├── <module>.permissions.js   scope resolvers for this module's targets
│   │   │   │   └── <module>.test.js          unit tests colocated
│   │   │   │   modules: auth organizations employees departments teams roles projects tasks
│   │   │   │            clients leads opportunities tickets quotes attendance time-tracking timesheets
│   │   │   │            monitoring leave reports financials notifications calendar custom-fields
│   │   │   │            integrations webhooks files audit dashboard platform health
│   │   │   ├── services/                     cross-cutting: audit.js, outbox.js, storage.js (S3),
│   │   │   │                                 mailer.js, crypto.js, clock.js (injectable now()), rbac.js
│   │   │   ├── repositories/                 prisma.js (client + tenant-guard extension), tx.js (retry)
│   │   │   ├── jobs/                         one processor per job type
│   │   │   ├── queues/                       queue definitions, default job options, schedulers
│   │   │   ├── sockets/                      io.js (auth handshake, room assignment), emitters
│   │   │   ├── utils/                        errors.js (AppError types), pagination.js, money.js, time.js
│   │   │   ├── validators/                   env & shared request helpers
│   │   │   └── openapi/                      + generator from route registry
│   │   ├── prisma/ schema.prisma  migrations/  seed.js  seed-data/
│   │   ├── tests/ unit/  integration/  e2e/  helpers/ (factories, test-app, db reset)
│   │   ├── openapi/                          generated openapi.json (CI checks it is up to date)
│   │   ├── vitest.config.mjs  eslint.config.mjs
│   │   └── package.json
│   │
│   └── desktop-agent/                        Electron
│       ├── src/
│       │   ├── main.js                       app lifecycle, tray, single-instance lock
│       │   ├── preload.cjs                   + contextBridge (renderer has no Node)
│       │   ├── renderer/                     + status window, pairing, notice/consent UI
│       │   ├── capture.js                    desktopCapturer, scheduling per server policy
│       │   ├── permissions.js                macOS screen-recording permission checks / prompts
│       │   ├── authentication.js             device keypair (keychain), pairing, token refresh
│       │   ├── uploader.js                   presign → PUT → complete, backoff
│       │   ├── local-queue.js                encrypted, size-capped, TTL queue
│       │   └── settings.js
│       ├── tests/
│       ├── electron-builder.config.cjs       + signing / notarization / auto-update feed
│       └── package.json
│
├── packages/
│   ├── shared-constants/                     enums, permission keys, event types, error codes
│   ├── validation/                           Zod schemas shared by web + api (shape only)
│   ├── api-client/                           fetch wrapper: envelope, CSRF header, errors → ApiError
│   └── eslint-config/                        + shared flat config (no-TS rule, import boundaries)
├── infrastructure/
│   ├── docker/  api.Dockerfile (targets: api, worker, migrate)  web.Dockerfile
│   ├── s3/      s3.json  (SeaweedFS S3 identities for local dev)
│   ├── nginx/   nginx.conf  conf.d/orbit.conf  (TLS, routing, limits, websocket upgrade)
│   ├── mysql/   my.cnf  init/ (users & grants)  triggers/ (append-only guards)
│   ├── redis/   redis.conf
│   ├── monitoring/ prometheus.yml  grafana/dashboards/  alerts.yml
│   └── scripts/ backup.sh  restore-verify.sh  release-migrate.sh
├── docs/
├── .github/workflows/ ci.yml  release.yml  backup-verify.yml
├── docker-compose.yml                        dev: mysql, redis, s3 (SeaweedFS), mailpit; --profile app adds api, worker, web, nginx
├── docker-compose.prod.yml                   + production overlay
├── package.json  pnpm-workspace.yaml  pnpm-lock.yaml  .npmrc  .nvmrc (24)
├── .env.example
└── README.md
```

## Guardrails that enforce "JavaScript only"

- The shared ESLint config fails on any import of a `.ts`/`.tsx` path.
- CI runs `git ls-files '*.ts' '*.tsx' ':!:**/node_modules/**'` and fails if anything is listed. Vendor `.d.ts` files inside `node_modules` are out of scope.
- shadcn `components.json`: `"tsx": false`. Next.js uses `jsconfig.json`. No `typescript` dependency in any `package.json`. A CI check enforces that too.
- Prisma: `generator client { provider = "prisma-client-js" }`, version pinned (see architecture D6).
- Module boundaries: `eslint-plugin-boundaries` forbids `modules/a/*` from importing `modules/b/*.repository.js`.
