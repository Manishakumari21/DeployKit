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

### Tests

```bash
cd apps/api
npm test                                   # fast unit + DB-backed queue/pipeline tests
npm run test:integration                   # git checkout (network)
npm run test:build                         # buildx (Docker + builder)
npx tsx --test src/infrastructure/runtime/dockerRuntimeManager.integration.test.ts  # runtime (Docker)
```

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

### Setup

1. Create a GitHub App: permissions Contents read-only, Metadata
   read-only; subscribe to `push`; set webhook URL to
   `https://<host>/api/webhooks/github` with a secret.
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
  `projects.branch`; `auto_deploy` defaults to false.
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

`docker compose up` runs the gateway (no published ports, no Docker
socket; socket stays worker-only). App containers still publish no
host ports; only the active release is reachable through the gateway
as `dk-p<shortid>.deploykit.local`.

### Tests

`npm test` runs unit + DB suites serially (`--test-concurrency=1`;
the suites share one database and parallel files deadlocked on
cascading project deletes). Docker suites stay separate:
`npm run test:integration` (incl. live gateway traffic-switch test),
`npm run test:build`.

### Limitations

* Single node; gateway is one nginx container (failure domain, no HA).
* No TLS/DNS automation; gateway serves plain HTTP on the runtime
  network with no published host ports.
* Readiness is HTTP 2xx/3xx on `/`; no app-specific health contracts.

## Phase 06 — Image registry & artifact lifecycle

Flow: `checkout -> Buildx --push to the local registry ->
registry-resolved immutable digest -> release (repository + digest)
-> runtime pulls repository@digest -> health verification ->
active release`. Release identity remains `repository@sha256:<digest>`;
mutable tags are never used as release identity. Rollback reuses the
stored digest and never rebuilds.

The registry is **development-only**: unauthenticated, reachable on
the internal `deploykit-default` network as `deploykit-registry:5000`,
no host ports published, data persisted in the
`deploykit-registry-data` volume (`registry:2.8.3`, pinned).
Only the worker touches the registry; the API has no registry access
and no registry dependency.

When `DEPLOYKIT_REGISTRY_HOST` is unset, the pipeline keeps the Phase 03
local behavior (`--load`, no push, no pull). When set, builds use
`--push` (never combined with `--load`), deployment status passes
through `pushing`, and the runtime pulls the digest reference before
`container create`. Digest resolution uses
`docker buildx imagetools inspect` against the registry (not the local
RepoDigests cache, which can disagree with the stored manifest).

### Environment variables (new)

| Var | Default | Purpose |
| --- | ------- | ------- |
| `DEPLOYKIT_REGISTRY_HOST` | unset (registry disabled) | registry hostname[:port], e.g. `deploykit-registry:5000` |
| `DEPLOYKIT_REGISTRY_NAMESPACE` | `deploykit` | registry namespace prefix |
| `DEPLOYKIT_REGISTRY_INSECURE` | `false` | `true` is LOCAL DEVELOPMENT ONLY (loopback / `deploykit-registry` hosts only) |

### Tests

```bash
cd apps/api
npm test                                   # fast unit + DB suites (no Docker/registry needed)
npm run test:registry                      # ephemeral 127.0.0.1 registry: push/digest/exists/restart/unreachable
```

`test:registry` boots its own throwaway registry container and removes
it afterwards; it does not use the Compose registry service or volumes.
`test:integration` skips the registry lifecycle tests unless
`DEPLOYKIT_TEST_REGISTRY_HOST` is set.

### Limitations

* No registry authentication, no TLS, no HA, no retention/GC policy,
  no image signing — not production-grade artifact storage.
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
