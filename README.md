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
