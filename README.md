# DeployKit

DeployKit is a self-hosted deployment platform that helps developers deploy applications from Git repositories.

The goal is to understand and build the core systems behind modern deployment platforms.

## Tech Stack

* TypeScript
* Node.js
* Express
* React
* PostgreSQL
* Docker
* Nginx
* GitHub Actions

## Architecture

```text
GitHub
   ↓
DeployKit
   ↓
Build
   ↓
Docker
   ↓
Application
```

## Project Structure

```text
deploykit/
├── apps/
│   ├── api/          # Backend API
│   └── web/          # Web dashboard
├── database/         # Database files
├── docs/             # Documentation
├── .env.example
├── .gitignore
└── README.md
```

## Development

### API

```bash
cd apps/api
npm install
npm run dev
```

API:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/api/health
```

Expected:

```json
{
  "status": "ok"
}
```

## Goal

DeployKit will eventually handle:

* Git repository integration
* Application builds
* Docker deployments
* Health checks
* Logs
* Rollbacks
* CI/CD
* Monitoring
* Infrastructure automation

## Phase 03 — Deployment Engine

Pipeline: `API -> durable job (PostgreSQL) -> worker -> Git checkout ->
Buildx -> immutable digest -> release -> runtime container ->
health verification -> active release`.

Deployment states: `queued -> cloning -> building -> verifying ->
deploying -> active`, with `failed` / `cancelled` from non-terminal
states and `failed -> queued` retry. Every transition writes a
`deployment_events` audit row; every claim writes a
`deployment_attempts` row.

### Run locally

```bash
# Postgres (healthy) then API
cd apps/api
npm install
npm run build
DATABASE_URL=postgresql://deploykit:deploykit@localhost:5432/deploykit \
PORT=3000 node dist/server.js

# Worker (separate process; needs Docker + deploykit-builder)
DEPLOYMENT_WORKER_ENABLED=true \
DATABASE_URL=postgresql://deploykit:deploykit@localhost:5432/deploykit \
DEPLOYKIT_RUNTIME_NETWORK=deploykit-runtime \
DEPLOYKIT_BUILDER_NAME=deploykit-builder \
node dist/workers/deploymentWorker.js
```

Or via compose: `docker compose up --build` (postgres healthy ->
api healthy -> worker; web waits for api; worker alone mounts
`/var/run/docker.sock`).

#### Start / stop the local stack

```bash
docker compose up -d        # start all services in the background
docker compose ps -a        # status + health of every service
docker compose logs -f api  # tail one service (or worker, web, gateway)
docker compose stop api     # stop one service (clean SIGTERM)
docker compose down          # stop and remove containers (keeps data volumes)
```

The API publishes on `127.0.0.1:3001`, the registry on
`127.0.0.1:5000`, and the gateway on `80/443`. The web frontend is
served on **http://localhost:8083** — that mapping comes from
`docker-compose.override.yml`, which is a local-only override and is
intentionally left uncommitted; the base compose file publishes no web
port. The frontend calls the API same-origin through `/api`, so the
browser reaches the backend through the web container's proxy without
any hardcoded host. On a clean stop the API logs
`SIGTERM received, shutting down` and exits `0`.

Builder (reproducible): `docker buildx create --name deploykit-builder
--driver docker-container --use` — config in
`ops/buildkit/buildkitd.toml` (`max-parallelism = 2`, no insecure
entitlements). Builds use `--builder deploykit-builder`, enforce
`--resource memory=...`, `--resource cpu-quota=...` (period 100000),
`--network default|none`, `--metadata-file` digest extraction.

### Environment variables

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DATABASE_URL` | — (required) | Postgres connection |
| `PORT` | `3000` | API listen port |
| `DEPLOYMENT_WORKER_ENABLED` | unset (worker idle) | must be `true` to claim jobs |
| `WORKER_POLL_INTERVAL_MS` | `2000` | queue poll interval |
| `WORKER_LEASE_MS` | `30000` | job lease duration |
| `DEPLOYKIT_RUNTIME_NETWORK` | `deploykit-runtime` | dedicated runtime network |
| `DEPLOYKIT_BUILDER_NAME` | `deploykit-builder` | Buildx builder instance |
| `DEPLOYKIT_DOCKER_BINARY` | `docker` | docker binary path |
| `DEPLOYKIT_ALLOWED_GIT_HOSTS` | `github.com` | Git host allowlist |
| `DEPLOYKIT_CHECKOUT_ROOT` | `<tmp>/deploykit-checkouts` | ephemeral checkout parent |
| `DEPLOYKIT_CHECKOUT_TIMEOUT_MS` | `300000` | git operation timeout |
| `DEPLOYKIT_BUILD_TIMEOUT_MS` | `600000` | build timeout (max 3600000) |
| `DEPLOYKIT_BUILD_MEMORY_BYTES` | `2147483648` | build memory (max 64GB) |
| `DEPLOYKIT_BUILD_CPU_LIMIT` | `2` | build CPUs as cpu-quota (max 32) |
| `DEPLOYKIT_MAX_BUILD_CONTEXT_BYTES` | `2147483648` | pre-build context size cap |

### API

* `POST /api/projects/:id/deployments` (`trigger: manual|github_push`,
  `Idempotency-Key` header) — rollback trigger rejected here.
* `POST /api/projects/:id/rollback` (`{ releaseId }`) — reuses the
  stored digest, never rebuilds; `failed` releases rejected.
* `GET /api/projects/:id/deployments`, `GET /api/deployments/:id`,
  `GET /api/deployments/:id/events`,
  `GET /api/projects/:id/releases`, `GET /api/releases/:id`,
  `POST /api/deployments/:id/cancel` (409 if terminal).
* `GET /api/projects/:id/events?limit=50` — project-wide deployment
  event stream, newest first (limit capped at 100).

### Tests

```bash
cd apps/api
npm test                                   # fast unit + DB-backed queue/pipeline tests
npm run test:integration                   # git checkout (network)
npm run test:build                         # buildx (Docker + builder)
npx tsx --test src/infrastructure/runtime/dockerRuntimeManager.integration.test.ts  # runtime (Docker)
```

#### Database test gate

DB-backed suites skip when PostgreSQL is unreachable, which previously made a
run look green while silently covering no database behavior. `src/test/dbGate.ts`
records a marker per database suite and the verifier fails when an expected
suite did not run.

| Command | Behavior |
| --- | --- |
| `npm test` | Runs the unit suites, then the gate verifier. Fails if a DB-backed suite was skipped (i.e. PostgreSQL must be reachable). |
| `npm run test:db-required` | Strict: fails fast with `REQUIRE_DB=1 but the database is unavailable` instead of skipping. Use in CI. |
| `npm run test:no-db` | Tolerates a missing database, exits 0, and prints exactly which suites did not run. Does not claim database coverage. |
| `npm run test:db-gate -- [unit\|integration\|all]` | Re-runs the verifier alone against an existing `DB_GATE_DIR`. Defaults to `unit`. |

Markers are written to a unique `.db-gate/run-*` directory per invocation
(cleared on success, retained on failure) so concurrent runs cannot interfere.

#### Database migrations

The DB-backed suites need a migrated schema. `npm run db:migrate` applies
`database/migrations/*.sql` in lexical order, one transaction per file, and
records applied files in `schema_migrations` so re-running is safe. It requires
`DATABASE_URL` explicitly and never guesses a database, so it cannot migrate a
developer database by accident. `001`/`002`/`004` are not idempotent, which is
why the applied-file record exists.

```bash
cd apps/api
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<database> npm run db:migrate
```

A session-scoped advisory lock serializes concurrent runners, so two
processes cannot apply the same file. `DEPLOYKIT_MIGRATIONS_DIR` overrides the
migrations directory; it exists so failure paths can be exercised with
fixtures and is unset in normal use and in CI.

CI (`.github/workflows/ci.yml`) runs `build -> db:migrate -> test:db-required`
against an ephemeral PostgreSQL service, so a skipped DB-backed suite fails the
job instead of passing silently.

### Security boundaries / limitations

* Git: HTTPS-only, allowlisted hosts, no embedded credentials, no
  submodules, `GIT_ASKPASS=/bin/false`, no shell interpolation
  (`execFile`/`spawn` with `shell: false` everywhere).
* Build: no user-controlled Docker flags; image repository/tag
  validated; tags are derived (`d-<dep>-<sha>`), never `latest`.
* Runtime: digest-pinned references required; env names validated;
  no host port publishing; no host mounts; `read-only`,
  `cap-drop ALL`, `no-new-privileges`, memory/CPU/PID limits;
  Docker socket mounted into the worker only, never api/web.
* Rollout is single-node stop-new-on-failure (old release stays
  active until the new one verifies); it is **not** zero-downtime
  (no reverse proxy / connection draining in Phase 03).
* Health checks target the image's exposed port (discovered from
  EXPOSE metadata, fallback 3000) at `/` over the runtime network.

## Phase 04 — GitHub App + automatic deployments

Flow: `GitHub push -> POST /api/webhooks/github (HMAC verified) ->
delivery persisted (PK delivery ID) -> repo/project resolved ->
deployment+job created (trigger github_push, exact SHA,
idempotency github:<delivery>) -> 202 -> worker (Phase 03 pipeline
checks out the pinned SHA; private repos use an installation token
passed via child-process env `GIT_CONFIG_*`, never argv/URL/logs)`.

Delivery claims are serialized per delivery with a transactional
advisory lock; `processing` rows carry a 5-minute lease, so a crash
between persist and deployment creation is resumed by redelivery
while a live handler is not double-processed. Deployment creation
stays idempotent (`github:<delivery>` unique), so repeats never
create a second deployment.

### Environment variables (new)

| Var | Purpose |
| --- | ------- |
| `GITHUB_APP_ID` | GitHub App ID (required for webhooks/private repos) |
| `GITHUB_APP_PRIVATE_KEY` | App RSA private key PEM (`\n` escapes allowed) |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret |
| `GITHUB_API_BASE_URL` | Default `https://api.github.com` (override for mocks) |
| `GITHUB_INSTALLATION_ID` | Optional default installation |

### Endpoints

* `POST /api/webhooks/github` (raw 1mb body): 202 accepted/duplicate/
  ignored, 401 bad signature, 400 malformed. Requires
  `X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`.
* `POST /api/projects/:id/github-link`
  (`{ installationId, repositoryFullName, repositoryId?, autoDeploy? }`)
* `GET /api/projects/:id/github-link`, `DELETE /api/projects/:id/github-link`
* `GET /api/github/connection` (install URL, callback URL, configuration state)
* `GET /api/github/repositories` (repositories visible to stored installations)
* `GET /api/github/callback` (GitHub App setup callback; state-verified)

### Setup

1. Create a GitHub App: permissions Contents read-only, Metadata
   read-only; subscribe to `push`; set webhook URL to
   `https://<host>/api/webhooks/github` with a secret. Set the App's
   Setup URL to `https://<host>/api/github/callback` to enable the
   in-app Connect GitHub flow.
2. Install the App on the repo; note installation ID + full_name.
3. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_WEBHOOK_SECRET` on api/worker; migrate DB through
   `007_github_integration.sql`.
4. Link: `POST /api/projects/:id/github-link` with installation +
   full_name (enables `auto_deploy`, matches `projects.branch`).
5. Push to the linked branch -> 202 -> worker deploys the exact SHA.

### Limitations

* Only `push` to `refs/heads/<branch>` auto-deploys; tags, PRs,
  deletions, other events are ignored (202).
* One linked repository per project; branch must equal
  `projects.branch`; `auto_deploy` defaults to true.
* Single-node worker; see Phase 05 for traffic-switch guarantees.

## Phase 05 — Zero-downtime releases via gateway

Flow: new release container starts beside the active one, must pass
HTTP readiness, then one DB transaction (per-project advisory lock)
marks it `active`, retires the old release, and records the traffic
route in `project_gateways`. The worker then repoints the `dk-gateway`
nginx container (`nginx -t` + graceful `nginx -s reload`, no dropped
connections) and verifies traffic through the gateway before stopping
the superseded runtime. Rollback reuses the stored image digest and
follows the same verify-then-switch path; it never rebuilds.

Guarantees actually implemented:

* At most one `active` release per project (partial unique index +
  serialized activation; repeated activation is a no-op).
* The old release keeps serving until the replacement is healthy AND
  the gateway route is verified; unhealthy releases never switch
  traffic and their runtimes are removed.
* PostgreSQL is the source of truth: gateway config is always
  (re)generated from `project_gateways` + the active release, so a
  crash between DB commit and reload converges on retry via
  `syncProjectGateway`. Activation is idempotent, cleanup is
  idempotent, deployment resume never rebuilds after a release exists.

### Environment variables (new)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DEPLOYKIT_GATEWAY_CONTAINER` | `dk-gateway` | gateway container for config reload |
| `DEPLOYKIT_GATEWAY_ROUTES_DIR` | `/gateway-routes` | shared routes volume in worker |
| `DEPLOYKIT_GATEWAY_HOST` | `dk-gateway` | gateway address for traffic verification |

`docker compose up` runs the gateway (publishes 80/443 for app routing
and the registry TLS alias; no Docker socket — socket stays
worker-only). App containers still publish no host ports; the active
release is reachable through the gateway
as `dk-p<shortid>.deploykit.local`.

### Tests

`npm test` runs unit + DB suites serially (`--test-concurrency=1`;
the suites share one database and parallel files deadlocked on
cascading project deletes). Docker suites stay separate:
`npm run test:integration` (incl. live gateway traffic-switch test),
`npm run test:build`.

### Limitations

* Single node; gateway is one nginx container (failure domain, no HA).
* The gateway publishes 80/443; the registry TLS alias
  (`deploykit-registry-tls`) is served from the `deploykit-certs`
  volume, and app-route certificates are issued via ACME by the
  worker's cert sweep.
* Readiness is HTTP 2xx/3xx on `/`; no app-specific health contracts.

## Phase 06 — Image registry & artifact lifecycle

Flow: `checkout -> Buildx --push to the local registry ->
registry-resolved immutable digest -> release (repository + digest)
-> runtime pulls repository@digest -> health verification ->
active release`. Release identity remains `repository@sha256:<digest>`;
mutable tags are never used as release identity. Rollback reuses the
stored digest and never rebuilds.

The registry is **development-only**: unauthenticated, bound to host
loopback as `127.0.0.1:5000` and reachable on the internal
`deploykit-default` network as `registry:5000`, data persisted in the
`deploykit-registry-data` volume (`registry:2.8.3`, pinned).
Only the worker touches the registry; the API has no registry access
and no registry dependency.

In compose the worker's registry host defaults to
`deploykit-registry-tls:443` — a network alias of the `dk-gateway`
nginx service, which terminates TLS (certificates mounted from the
`deploykit-certs` volume) and proxies to `http://registry:5000`.
Worker bootstrap provisions the CA into BuildKit
(`/certs/deploykit-registry-tls/ca.crt`), and host-side tooling trusts
the same CA via `/etc/docker/certs.d/deploykit-registry-tls:443/ca.crt`.

When `DEPLOYKIT_REGISTRY_HOST` is unset, the pipeline keeps the Phase 03
local behavior (`--load`, no push, no pull). When set, builds use
`--push` (never combined with `--load`), deployment status passes
through `pushing`, and the runtime pulls the digest reference before
`container create`. The digest is read from the buildx
`--metadata-file` output (`containerimage.digest`), must match
`sha256:<64 hex>`, and is persisted on `deployments.image_digest` /
`releases.image_digest`; the runtime container runs the digest-pinned
reference so a mutable tag can never substitute for the built image.

### Registry authentication (opt-in)

By default the registry runs **unauthenticated on loopback only** — a
development-only posture that is safe because the registry port is
bound to `127.0.0.1:5000` and never exposed publicly. For any
deployment that exposes the registry beyond loopback, htpasswd auth is
available via an opt-in compose overlay:

```bash
# 1. Generate a strong password (never commit it, never echo it into argv):
export DEPLOYKIT_REGISTRY_USERNAME=deploykit
export DEPLOYKIT_REGISTRY_PASSWORD="$(openssl rand -hex 32)"

# 2. Bring the stack up WITH the auth overlay:
docker compose -f docker-compose.yml -f docker-compose.registry-auth.yml up -d
```

What the overlay does:

* `registry-auth-init` (one-shot `httpd:alpine`) generates a **bcrypt
  htpasswd** from the env credentials into the `deploykit-registry-auth`
  volume. The plaintext password is piped to `htpasswd -niB` via stdin —
  it is never placed in a process argv, written to disk, or baked into
  an image; only the hash is stored.
* The registry mounts that file read-only, sets
  `REGISTRY_AUTH=htpasswd` + `REGISTRY_AUTH_HTPASSWD_REALM`, and enforces
  basic auth on every `/v2/` request. The healthcheck is 401-tolerant
  (a 401 challenge still proves the registry is up).
* The worker receives the same credentials and, during bootstrap, runs
  `docker login --password-stdin` against the registry host. The
  credentials persist under `DOCKER_CONFIG` (inside the buildx config
  dir), so `docker image push`, `docker image pull`, `docker buildx
  build --push`, and `docker buildx imagetools inspect` all reuse them.
* The gateway TLS route (`deploykit-registry-tls:443`) forwards the
  `Authorization` header by default, so authenticated clients work
  through TLS unchanged.

**Fail-closed guard:** the overlay refuses to start without
`DEPLOYKIT_REGISTRY_PASSWORD` (`docker compose config` errors with
`DEPLOYKIT_REGISTRY_PASSWORD must be set when registry auth is
enabled`), and the init container exits non-zero on an empty password —
so the registry can never come up open when the overlay is selected.

**Credential flow:**

| Path | Dev (default) | Production (overlay) |
| --- | --- | --- |
| Registry auth | none (loopback only) | htpasswd (bcrypt) |
| Worker push/pull | no login | `docker login` → `DOCKER_CONFIG` → CLI → daemon |
| BuildKit `--push` | no auth | buildx forwards client creds to buildkitd |
| Gateway `Authorization` | n/a | forwarded by nginx (default) |

**Rotation:** set a new `DEPLOYKIT_REGISTRY_PASSWORD`, then
`docker compose -f docker-compose.yml -f docker-compose.registry-auth.yml
up -d --force-recreate registry-auth-init registry worker`. Existing
images already pushed are unaffected (the digest references stay valid);
only new pushes/pulls require the new password.

**Prerequisite:** the host Docker daemon must trust the registry CA at
`/etc/docker/certs.d/<registry-host>/ca.crt` for daemon-side pulls, and
the worker trusts it via `SSL_CERT_FILE` (provisioned from the
`deploykit-certs` volume) for the login handshake.

### Environment variables (new)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DEPLOYKIT_REGISTRY_HOST` | unset (registry disabled; compose: `deploykit-registry-tls:443`) | registry hostname[:port], e.g. `deploykit-registry-tls:443` |
| `DEPLOYKIT_REGISTRY_NAMESPACE` | `deploykit` | registry namespace prefix |
| `DEPLOYKIT_REGISTRY_INSECURE` | `false` | `true` is LOCAL DEVELOPMENT ONLY (loopback / `deploykit-registry` hosts only) |
| `DEPLOYKIT_REGISTRY_USERNAME` | unset (compose: `deploykit`) | htpasswd username for registry auth |
| `DEPLOYKIT_REGISTRY_PASSWORD` | unset (auth disabled) | htpasswd password; when set + overlay included, auth is enforced |

### Tests

```bash
cd apps/api
npm test                                   # fast unit + DB suites (no Docker/registry needed)
npm run test:registry                      # ephemeral 127.0.0.1 registry: push/digest/exists/restart/unreachable
npm run test:integration                   # includes registryAuth.integration.test.ts (auth on/off)
```

`test:registry` boots its own throwaway registry container and removes
it afterwards; it does not use the Compose registry service or volumes.
`test:integration` skips the registry lifecycle tests unless
`DEPLOYKIT_TEST_REGISTRY_HOST` is set; the registry-auth integration
test is self-contained (it starts its own ephemeral htpasswd registry
and proves anonymous push → 401, `docker login` + push → success,
wrong password → login fails).

### Limitations

* Registry authentication is **implemented and tested but opt-in**
  (see "Registry authentication" above): the default dev stack keeps
  the registry unauthenticated on loopback only. No HA, no
  retention/GC policy, no image signing — not production-grade
  artifact storage.
* Host-Docker prerequisite for registry pulls (NOT automated by
  DeployKit, which never touches host daemon config): the runtime
  `docker image pull repository@digest` executes on the HOST Docker
  daemon through the worker-mounted socket, so the host daemon itself
  must resolve the registry hostname AND trust plain HTTP — i.e. an
  `insecure-registries` entry for `deploykit-registry:5000` (plus name
  resolution) followed by a daemon restart. Without this, registry-mode
  deployments fail at pull with `RUNTIME_FAILED` while the previous
  active release keeps serving. Loopback registries are exempt from the
  insecure entry by default, but a loopback hostname cannot serve both
  the builder netns and the host daemon at once.
* Worker/build-side registry path IS automatic: worker bootstrap
  writes the builder's `buildkitd.toml` (base from
  `ops/buildkit/buildkitd.toml` plus `http = true` for the configured
  insecure registry), converges the deterministic `deploykit-builder`
  to it idempotently, and attaches the builder container to the
  worker's networks so BuildKit pushes reach Compose registries.
* Edge-targeted deployments stop at a trusted, digest-pinned local
  container. Release activation, gateway traffic switching, and
  rollback are **not** implemented for edge agents (central
  deployments activate and roll back normally). A succeeded edge job
  means a healthy container on the agent host, not served traffic; a
  failed or blocked rollout never touches the running deployment (see
  `docs/edge-agent.md` §9–§10).

## Phase 08 — Worker/build hardening

Bootstrap (`workers/workerBootstrap.ts`, runs before the queue starts;
fail closed): `STARTING -> BOOTSTRAPPING (docker_cli, docker_daemon,
buildx, builder_ensure/create/reused, builder_bootstrap,
registry reachability, builder_network, orphan_cleanup) ->
READY -> PROCESSING`. No jobs are claimed until `READY`. `BUILDX_CONFIG`
points at worker-controlled `/tmp/deploykit-buildx` (persisted in the
`deploykit-buildx-state` volume); no host `~/.docker` data is mounted.

* Builder `deploykit-builder` (`docker-container` driver, Buildx
  v0.37.1 pinned in `Dockerfile.worker`) is created on demand,
  recreated only when the desired buildkitd config changes (marker
  file), otherwise reused — warm build cache is preserved.
* Build resource enforcement uses ONLY `buildx build --resource`
  (`memory=<bytes>`, `cpu-quota=<cpus>*100000`), the flags supported by
  the installed Buildx. They limit individual RUN/build-step
  containers, NOT the BuildKit daemon as a whole.
* Timeouts kill the real child (`SIGKILL`); cancellation propagates via
  `AbortSignal` through git/build/pull/health verification, and API
  cancellation is polled so active work aborts with typed
  `DEPLOYMENT_CANCELLED` without resurrecting the job.
* Cleanup is scoped to DeployKit-owned names/labels only
  (`dk-p<8hex>-d<8hex>`, `io.deploykit.managed=true`); never global
  prune. Failed deployments never disturb the active release.

## Phase 09 — Observability (logs + metrics)

Deployment **events** (`deployment_events`: `deployment.queued`,
`deployment.build_started`, `deployment.image_pushed`,
`deployment.verified`, …) remain the structured state history.
Operational **logs** (`deployment_logs`) are the git/build/runtime
output. The concepts are separate and queried separately.

Flow: pipeline phase hooks (`git` via `sourceCheckout.onLog`,
`build` via `BuildRequest.onLog` streaming `--progress plain` lines,
`registry`/`runtime`/`healthcheck`/`gateway` via pipeline log points)
-> `services/deploymentLogService.ts` (redact + normalize + bound) ->
Postgres `deployment_logs` (`010_deployment_logs.sql`) ->
`GET /api/deployments/:id/logs` (cursor pagination) ->
dashboard `LogsView` (3s cursor polling).

Persisted vs live: only a **bounded window** is persisted per
deployment (default 2000 lines / 1 MiB, 8 KiB per line; marker row
`{truncated: true, reason: "deployment_limit"}` records truncation).
On health/runtime failure a bounded container tail (`docker logs
--tail 100`, DeployKit-owned `dk-p<8hex>-d<8hex>` containers only) is
persisted for diagnostics. Unbounded `docker logs` streams are never
copied into Postgres; use `docker logs` on the runtime host for full tails.

### Environment variables (new)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DEPLOYKIT_LOG_RETENTION_DAYS` | `30` (1..365) | `deleteExpiredLogs()` horizon |
| `DEPLOYKIT_LOG_MAX_LINES_PER_DEPLOYMENT` | `2000` (1..20000) | per-deployment line cap |
| `DEPLOYKIT_LOG_MAX_BYTES_PER_DEPLOYMENT` | `1048576` (64KiB..10MiB) | per-deployment byte cap |
| `DEPLOYKIT_LOG_MAX_MESSAGE_BYTES` | `8192` (1KiB..64KiB) | per-line cap |

Zero/negative/absurd values throw at startup (`config/logConfig.ts`).

### API

* `GET /api/deployments/:id/logs?cursor=&limit=&source=&level=&direction=`
  -> `{items, next_cursor, truncated}`. Cursor is the last seen
  `deployment_logs.id`; `limit` clamped to 1..200 (default 100). No
  OFFSET. No cross-project reads (deployment UUIDs are unguessable and
  scoped via `deployment_logs.project_id`).
* `GET /api/projects/:id/metrics` -> sampled deployment/queue/runtime/
  worker metrics from indexed aggregates (polled, not real-time). No
  platform-wide endpoint (no authenticated platform scope exists).

Real-time: SSE (`/logs/stream`) was evaluated and deferred — no
authenticated streaming infrastructure, no connection accounting, and
deployments are short-lived. Cursor polling gives bounded reads without
held connections; see `web/src/hooks/useDeploymentLogs.ts`.

### Security

Git tokens, `GIT_CONFIG_*` secret content, private URLs with secrets,
and env dumps are never logged. `redactSecrets` + metadata key
allowlist mirror the `deploymentEvents` policy; command lines that
could contain secrets are not persisted (phase tags instead).

## Phase 10 — Identity, sessions & security boundary

Browser
  ↓
Authentication (login/register → opaque session)
  ↓
HttpOnly cookie (`deploykit_session`, SameSite=Lax)
  ↓
CORS allowlist + Origin check on unsafe methods
  ↓
Rate-limited auth endpoints
  ↓
authorizationService (project membership, role `owner`)
  ↓
Projects / Deployments / Releases / Logs / Metrics / GitHub

### Migrations

* `011_users.sql` — `users(id, email, password_hash, created_at, updated_at)`;
  email stored normalized, unique on `lower(email)`; bcrypt `$2b$` cost 12
  (12–72 char passwords); `PublicUser` never exposes the hash.
* `012_project_members.sql` — `project_members(project_id, user_id, role,
  created_at)`, PK `(project_id, user_id)`, both FKs `ON DELETE CASCADE`,
  `role CHECK IN ('owner')`. Legacy projects have zero rows = explicitly
  unowned = denied (fail closed, never public, never guessed).
* `013_sessions.sql` — `sessions(id, token_hash, user_id, expires_at,
  created_at, revoked_at)`; only the SHA-256 digest of the 256-bit token is
  stored. User deletion cascades sessions.
* `014_auth_rate_limits.sql` — `auth_rate_limits(key, window_start, count)`;
  one row per bucket/window with lazy expiry.

### Endpoints

* `POST /api/auth/register` — gated: open only when
  `DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION=true` or no account exists yet
  (first-user bootstrap, closes automatically). 201 `PublicUser`, no
  session; 409 duplicate, 403 when closed, 429 when throttled.
* `POST /api/auth/login` — `{email, password}` → 200 `PublicUser` +
  `Set-Cookie`; 401 generic (`Invalid email or password`, identical for
  unknown emails, with dummy bcrypt compare); 400 malformed; 429 throttled.
* `POST /api/auth/logout` — revokes the session, clears the cookie, always
  200 `{loggedOut: true}` even without a session.
* `GET /api/auth/session` — 200 `{user}` on a valid cookie, else 401.
  Frontend startup gate (see `web/src/hooks/useAuth.ts`).

All project/deployment/release/log/metrics/GitHub routes require a valid
session (401 otherwise) plus membership via `authorizationService`
(403 `Access denied` for strangers and unowned projects; unknown
deployment/release ids stay 404). `GET /api/health` stays public;
`POST /api/webhooks/github` stays sessionless GitHub-HMAC machine auth.

### Cookie/security model

* `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` = session lifetime
  (default 7 days via `DEPLOYKIT_SESSION_DAYS`); `Secure` in production
  (`NODE_ENV=production`) unless `DEPLOYKIT_COOKIE_SECURE` overrides.
* CORS (`config/corsConfig.ts`): explicit `DEPLOYKIT_WEB_ORIGIN` list
  (required in production, dev defaults to the vite ports); credentials
  reflected only for allowlisted origins, never wildcard; non-browser
  clients (no `Origin`) pass through without ACAO headers.
* CSRF (`middleware/origin.ts`): unsafe methods require a trusted
  `Origin`/`Referer` against the same allowlist; absent headers = non-
  browser client, allowed. Applies to auth + project/deployment routers,
  never to webhooks or safe methods. SameSite=Lax remains the first layer.
* Rate limiting (`services/rateLimitService.ts`): PG fixed-window buckets
  per IP (all attempts) and per account (consecutive failures; success
  clears). 429 + `Retry-After`, generic message, checked before user
  lookup. No unbounded in-memory state; safe across instances.
* Never logged/returned: passwords, hashes, session tokens, cookies,
  CSRF internals, GitHub credentials (extends the Phase 09 policy).

### Local development accounts

Fresh database: open the dashboard, create the first account via the
register tab (bootstrap window), then sign in. To allow further open
registration set `DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION=true`; otherwise
create accounts via `POST /api/auth/register` with the flag temporarily
enabled, or directly through `userService.createUser`. New projects are
owned atomically by their creator; legacy pre-auth projects stay
inaccessible until an explicit `addProjectOwner(projectId, userId)` call.

### Known limitations (not implemented)

No SSO/OAuth, no MFA, no organizations/teams, no roles beyond `owner`,
no login notifications or session listing/revocation UI, single-node
rate-limit cleanup is lazy (no background sweeper), and the web origin
must be configured explicitly in production.

## Phase 11 — Custom domains + TLS/ACME

Custom hostnames map to projects (`custom_domains`), verified by DNS TXT
(`_deploykit-challenge.<domain>`), then served through the existing gateway
with per-domain certificates issued over ACME HTTP-01 (lego v5.5.2 in the
worker image). One certificate per domain; no wildcard/DNS-01 support.

Flow: verify domain in the dashboard → `POST /api/domains/:id/certificate`
(202 arms `tls_status=pending`) → worker claims it, lego validates over the
gateway's port 80 (challenge path bypasses all redirects), installs
`domains/<domain>/{fullchain,private-key}.pem` atomically, renders HTTPS,
`nginx -t` + reload, verifies HTTPS, then marks `issued` — only then does
HTTP redirect to HTTPS. Domains without a valid certificate stay on HTTP.

Renewal is due-date-driven (30d window, serialized per domain via advisory
locks); failed renewals keep the old certificate serving; expired rows flip
to `expired` and the gateway drops HTTPS + redirect while HTTP continues.
Any nginx/reload/verify failure restores the previous known-good config and
previous files. Keys live only in the `deploykit-certs` volume (worker
read/write, gateway read-only) — never in PostgreSQL, logs, or API output.
ACME defaults to the staging CA; production needs `DEPLOYKIT_ACME_SERVER`
plus a public DNS A/AAAA record and reachable ports 80/443.

### Environment variables (new)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DEPLOYKIT_ACME_EMAIL` | unset (issuance waits) | ACME account email (required) |
| `DEPLOYKIT_ACME_SERVER` | staging CA | production CA URL for real certs |
| `DEPLOYKIT_TLS_MODE` | `acme` | `self-signed` is local-dev only, refused in production |
| `DEPLOYKIT_CERTS_DIR` | `/certs` | certificate filesystem root |
| `DEPLOYKIT_CERT_POLL_INTERVAL_MS` | `60000` | worker cert sweep interval (min 10s) |
| `DEPLOYKIT_LEGO_BINARY` | `lego` | lego binary override (tests) |

### Production prerequisites

Public DNS A/AAAA to the gateway host, TCP 80 reachable (HTTP-01),
TCP 443 reachable (HTTPS), valid `DEPLOYKIT_ACME_EMAIL`, production CA URL.
Respect Let's Encrypt rate limits (failed orders are NOT auto-retried —
re-arm via the dashboard). Localhost is never publicly ACME-valid; use
`DEPLOYKIT_TLS_MODE=self-signed` for local HTTPS testing only.

## Operations — rollback & troubleshooting

### Database backup & restore

`ops/backup/backup-db.sh` and `ops/backup/restore-db.sh` wrap
`pg_dump`/`pg_restore` with guardrails. Both read `DATABASE_URL` from
the environment (or `.env`).

```bash
# Take a compressed custom-format dump (default ./backups/<db>-<ts>.dump):
cd ops/backup && ./backup-db.sh

# Restore into a NEW scratch database (default <db>_restore_<ts>) — never
# touches the live database:
./restore-db.sh backups/deploykit-2026-10-31T12-00-00.dump

# Restore OVER the live database (destructive!) — requires typing the
# exact database name to confirm:
./restore-db.sh --force-live backups/deploykit-....dump
```

The scripts verify the dump magic bytes (`PGDMP`) and non-emptiness
before restoring, and refuse a live-DB restore without `--force-live`
plus interactive confirmation. Dumps land in `backups/`, which is
git-ignored.

Suggested cron for nightly backups (adjust paths/credentials):

```cron
15 3 * * * cd /srv/deploykit/ops/backup && DATABASE_URL="$DEPLOYKIT_DATABASE_URL" ./backup-db.sh >> /var/log/deploykit-backup.log 2>&1
```

Copy dumps off-host regularly; a backup that only lives on the database
host does not survive that host's loss.

### Rollback

`POST /api/projects/:id/rollback` with `{ "releaseId": "<uuid>" }`
(session auth) creates a rollback deployment. The worker copies the
target release's stored `repository@sha256:<digest>` and redeploys it
without rebuilding: a new active release is created carrying that
digest, the previously active release is stopped, and the runtime
container is replaced with the digest-pinned reference. List releases
via `GET /api/projects/:id/releases`.

The web UI now offers this directly: the **Releases** view lists every
release (status pill, digest, age) with a **Roll back** button per
release. The button is disabled — with an explanatory tooltip — for
failed releases (the backend rejects them as rollback targets) and
while a deployment is in flight (the backend returns 409), and it asks
for a confirmation step before dispatching.

### Troubleshooting

* `docker compose` fails with a `.env` parse error: compose reads
  `.env` strictly (no spaces around keys, no stray free-text lines).
  Validate with `docker compose config --quiet`.
* Worker exits immediately: check `docker logs deploykit-worker` for
  `worker.bootstrap_failed`. Bootstrap fails closed when the Docker
  CLI/daemon is unavailable, the `deploykit-builder` cannot be created,
  or the registry (`deploykit-registry-tls:443`) is unreachable — the
  CA must exist in the `deploykit-certs` volume.
* Host cannot push/pull via `deploykit-registry-tls:443`: the hostname
  must resolve to the gateway (e.g. an `/etc/hosts` entry) and the
  daemon must trust the CA at
  `/etc/docker/certs.d/deploykit-registry-tls:443/ca.crt`.
* `npm run test:build` fails with `no builder "deploykit-builder"
  found`: the executor uses `DEPLOYKIT_BUILDER_NAME` (default
  `deploykit-builder`) from the runner's `BUILDX_CONFIG`. Point
  `BUILDX_CONFIG`/`DEPLOYKIT_BUILDER_NAME` at a local builder or run
  inside the worker container; CI excludes Docker-dependent suites.
* A deployment is `failed`: `GET /api/deployments/:id` carries
  `error_code`/`error_message` (secret-redacted), and
  `GET /api/deployments/:id/events` shows the full transition trail
  (`runtime.unhealthy` means the `dk-*` runtime container stopped).
