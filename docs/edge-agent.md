# DeployKit Edge Agent (Phase 12.5)

Standalone executor that polls the DeployKit control plane with a machine
credential and runs edge-targeted deployments against the local Docker
Engine. It reuses the Phase 12.4 executor, client, and Docker abstraction;
this guide covers only packaging, configuration, enrollment, and operations.

> A passing unit suite does **not** establish successful remote-agent
> deployment. Only a real Docker + remote-agent end-to-end run proves that,
> and none has been performed yet.

## 1. Prerequisites

- Node.js 22+ (standalone process) **or** Docker Engine 24+ with Compose
  (container).
- Network route from the edge host to the control plane (`https://…` in
  production; loopback `http://…` for local development only).
- A local Docker Engine with the `deploykit-runtime` network present
  (`docker network create deploykit-runtime` if it does not exist) and a
  registry the control plane trusts for the images you intend to run.
- A project UUID on the control plane (for enrollment).

The agent makes **outbound** connections only and publishes no inbound port.

## 2. Required configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DEPLOYKIT_CONTROL_PLANE_URL` | yes | — | Bare `https://host[:port]` origin (no path/query/credentials) |
| `DEPLOYKIT_AGENT_TOKEN` | yes | — | 256-bit opaque enrollment credential (never logged) |
| `DEPLOYKIT_AGENT_ID` | no | — | Expected agent UUID; work leased to another id is refused |
| `DEPLOYKIT_EDGE_ALLOW_HTTP` | no | `false` | `true` permits plain HTTP **only** for local development (loopback hosts, or compose-internal names such as `api`) |
| `DEPLOYKIT_EDGE_POLL_INTERVAL_MS` | no | `5000` | Idle poll interval, 1000–60000 |
| `DEPLOYKIT_EDGE_REQUEST_TIMEOUT_MS` | no | `15000` | Per-request timeout, 1000–120000 |
| `DEPLOYKIT_EDGE_HEARTBEAT_INTERVAL_MS` | no | `10000` | Lease renewal cadence, 1000–60000 |
| `DEPLOYKIT_EDGE_EXECUTION_TIMEOUT_MS` | no | `600000` | Whole-run cap, 30000–3600000 |
| `DEPLOYKIT_DOCKER_BINARY` | no | `docker` | Docker CLI path (no shell metacharacters) |
| `DEPLOYKIT_EDGE_NETWORK` | no | `deploykit-runtime` | Container network (host networking forbidden) |
| `DEPLOYKIT_EDGE_MEMORY_BYTES` | no | `536870912` | 64 MiB–8 GiB |
| `DEPLOYKIT_EDGE_CPU_LIMIT` | no | `1` | 1–16 |
| `DEPLOYKIT_EDGE_PIDS_LIMIT` | no | `256` | 16–4096 |
| `DEPLOYKIT_EDGE_CONTAINER_PORT` | no | `3000` | 1–65535 |
| `DEPLOYKIT_EDGE_HEALTH_PATH` | no | `/` | Must start with `/` |
| `DEPLOYKIT_EDGE_HEALTH_TIMEOUT_MS` | no | `60000` | 5000–300000 |
| `DEPLOYKIT_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |

Startup rejects missing/malformed/insecure values with exit code `2`
before any work is claimed. There is **no** TLS-bypass setting; running
with `NODE_TLS_REJECT_UNAUTHORIZED=0` or any `DEPLOYKIT_EDGE_*TLS*` knob
fails startup. There is **no** default image: without a trusted
digest-pinned image from the control plane the agent reports the job
blocked (`EDGE_IMAGE_CONTRACT_MISSING`) and creates no container.

## 3. Enrollment and first startup

There is no public enrollment endpoint by design. Enroll on the
**control-plane host** (it needs `DATABASE_URL`, which never leaves that
host):

```bash
cd apps/api
DATABASE_URL=postgresql://deploykit:deploykit@postgres:5432/deploykit \
  npm run agent:enroll -- --project <project-uuid> --name <agent-name>
```

Copy the printed token **once** — only its SHA-256 digest is stored, so it
can never be shown again. Configure the edge host:

```bash
export DEPLOYKIT_CONTROL_PLANE_URL=https://deploykit.example.com
export DEPLOYKIT_AGENT_TOKEN='<token-from-enrollment>'
```

Standalone process (from `apps/api` after `npm run build`):

```bash
npm run agent
# or: node dist/edgeAgent.js
```

Container (compose profile; token passed at run time, never baked in):

```bash
DEPLOYKIT_AGENT_TOKEN='<token>' docker compose --profile edge up --build edge-agent
```

On first start expect `agent.starting`, `docker.preflight_ok`, then
`agent.running`. An idle agent logs at `debug` only.

## 4. Docker connectivity checks

Preflight (read-only, runs before any claim) verifies:

1. `docker version` reaches the daemon (proves CLI + socket).
2. `docker network inspect $DEPLOYKIT_EDGE_NETWORK` succeeds.

Failure exits `3` with an actionable message (e.g. create the network or
point `DEPLOYKIT_EDGE_NETWORK` at an existing one). Preflight installs
nothing, reconfigures nothing, prunes nothing, and removes no containers.

## 5. Graceful shutdown

`SIGTERM`/`SIGINT` stops new claims immediately; the in-flight run is
aborted and its owned container is stopped/removed before the process
exits (`0`). No polling timers or child processes survive shutdown (Docker
commands are killed via abort). A deployment interrupted this way stays
`running` server-side until its lease expires, then is recovered and
retried — never silently marked complete.

## 6. Credential rotation and revocation

- **Rotation:** enroll a second credential for the same agent
  (`agent:enroll` again), update `DEPLOYKIT_AGENT_TOKEN` on the edge host,
  restart the agent, then revoke the old credential id (server side). The
  agent exits `4` on its own if its credential is rejected, so a missed
  rotation is loud, not silent.
- **Revocation:** revoke the credential or the agent server-side; the
  agent stops at the next authenticated call and cleans up owned
  containers. In-flight jobs are recovered by lease expiry.

## 7. Troubleshooting

| Symptom | Cause / action |
|---|---|
| Exit `2`, `agent.config_invalid` | Fix the named variable; values are never echoed — recheck for typos/whitespace |
| Exit `3`, `docker.preflight_failed` | Daemon/socket unreachable, or network missing (see §4) |
| Exit `4`, `agent.revoked` | Rotate/re-enroll (§6) |
| `agent.job_blocked` / `EDGE_IMAGE_CONTRACT_MISSING` | Control plane has no trusted image for the deployment yet (fresh builds, local-only images); expected until activation/rollout contracts land |
| `agent.transient` with growing `backoffMs` | Control-plane outage; bounded backoff (≤60 s) then reconcile — do not restart aggressively |
| `agent.lease_lost` | Another owner/recovery took the job; owned containers were cleaned; next poll reconciles |

Logs are single-line JSON (`component: "edge-agent"`); fields are bounded
and bearer/token patterns are redacted. `debug` enables idle-poll lines.

## 8. Security implications of Docker socket access

Mounting `/var/run/docker.sock` gives the agent — and anyone who
compromises it — effective root on the host (container escape via
privileged siblings is trivial with daemon access). Mitigations applied:

- Agent containers it creates are unprivileged, read-only-rootfs,
  capability-dropped, CPU/memory/pids-limited, with no host mounts and no
  host networking; only `PORT`/`DEPLOYKIT_DEPLOYMENT_ID` are injected.
- The agent only stops/removes containers proving ownership (name +
  `io.deploykit.*` labels); unrelated containers are never touched.
- The agent never receives database credentials; its token is
  project-scoped and revocable.

Residual risks: run the agent on a dedicated host/VM, restrict who can
deploy the agent container, rotate tokens, and never expose the socket
over TCP.

## 9. Current limitations and unsupported scenarios

- **No remote-agent E2E has been run.** Unit + PostgreSQL integration
  only; Docker behavior is proven by fakes plus the shared
  `DockerRuntimeManager` integration suite (needs a daemon).
- Fresh manual edge deployments have no trusted image and fail closed
  **unless** the Phase 12.6B.1 build phase is enabled (see §10).
- Edge release activation, traffic switching, and rollback are **not**
  implemented: a succeeded edge job means a healthy local container, not
  served traffic.
- Private registry credential delivery is **not** implemented:
  unauthenticated pulls only.
- No dashboard/rollout integration (deferred to Phase 12.6).
- **In-flight agent cancellation is not server-authoritative.** Cancelling an
  edge deployment clears the job lease, and the agent discovers this on its
  next heartbeat and reports `EDGE_LEASE_STALE`. There is no dedicated
  cancellation signal, so the agent is not told "this was cancelled" and does
  not distinguish it from a lost lease. The agent's local `AbortSignal`
  (SIGTERM/shutdown) is process-local and is **not** a server-authoritative
  cancellation mechanism. Detection is bounded by the heartbeat interval
  (default 10 s).

### Edge job completion and deployment status

When an agent reports a successful edge job, the control plane records
successful **local execution** and writes a `deployment.agent_completed`
event. That event — not the deployment status — is the authoritative record
of a completed edge deployment.

- The deployment status is intentionally **not** transitioned to `active`
  merely because the local container reported healthy. `active` is reserved
  for deployments that have been activated and are serving traffic.
- Release activation, traffic switching, and rollback remain separate,
  unimplemented capabilities (see the limitations above).
- Consequently the deployment row is left at a non-terminal status
  (typically `cloning`) once the job succeeds. That status does **not** by
  itself communicate completion, and can be confusing to read.
- This does not block further work: the per-project concurrency guard only
  matches deployments whose job is still `queued` or `running`, so a new
  deployment can be created as soon as the edge job has succeeded.

A truthful terminal status distinct from `active` would improve this
reporting, but that is new status modelling and is deliberately left to a
separately approved design.

## 10. Edge image build (Phase 12.6B.1, opt-in)

Edge-targeted deployments are excluded from the central deployment worker
(`target_agent_id IS NULL`), so they had no path to a trusted image and always
failed closed with `EDGE_IMAGE_CONTRACT_MISSING`. The build phase closes that
gap **without** adding activation.

Enabled with `DEPLOYKIT_EDGE_BUILD_ENABLED=true` (default `false`).

| Stage | Owner | Effect |
| --- | --- | --- |
| Build claim | central worker | Job moves to `job_phase='build'`; `build_attempts` incremented; a `lease_token` is minted. |
| Build | central worker | Checkout → preflight → Buildx `--push` → verified `sha256:` digest read from the build metadata. |
| Hand-off | central worker | `completeEdgeBuildPhase` atomically persists the digest, flips the job to `job_phase='execute'` and requeues it. **No release row is created and nothing is deployed.** |
| Execution | edge agent | The agent may only claim `job_phase='execute'` jobs that have a digest. |

Guarantees:

- **Registry required.** Without `DEPLOYKIT_REGISTRY_HOST` the build fails
  closed before checkout; no default registry, image or credential is invented.
- **Immutable and trusted.** The digest must match `sha256:[0-9a-f]{64}` and the
  repository must be registry-qualified. Mutable tags are rejected.
- **No race.** A build claim requires `job_phase='build'`; an agent claim
  requires `job_phase='execute'`. Neither can take work the other holds, and
  anti-stealing of an edge job from the central worker still comes from the
  existing `target_agent_id IS NULL` claim filter. A job with no trusted image
  is still claimed by the agent (with `image: null`) and fails closed in the
  executor — see §9.
- **Stale owners cannot mutate.** Build completion and failure are fenced by
  `lease_token` as well as `locked_by`, so a worker that lost its lease cannot
  hand off or fail the job afterwards.
- **Separate retry budget.** Build retries use `build_attempts` /
  `max_build_attempts`. The execution budget (`attempts` / `max_attempts`) and
  the `deployment_attempts` audit table are never touched by the build path.
- **First write wins.** If a digest was already persisted, a later build does
  not overwrite it; it still hands the job to the execution phase.

Rollout order: apply `018_edge_build_phase.sql` **before** deploying code that
references `job_phase`; the deployment worker then runs with the flag off, and
the flag is enabled per environment afterwards.

### Disabling the flag after it has been enabled

Turning `DEPLOYKIT_EDGE_BUILD_ENABLED` back off does **not** strand jobs that
were created while it was on. On each worker poll the central worker demotes
**queued** build-phase jobs to the execute phase and records a
`deployment.edge_build_demoted` event for each one:

- Only `queued` jobs are demoted. A `running` build is left alone, so an
  in-flight build finishes or fails on its own terms rather than having its
  lease stolen.
- Demotion changes only `job_phase` (plus scheduling timestamps). Lease fields,
  cancellation state and the deployment's own status are untouched, and no
  image metadata is invented.
- The demoted job then fails closed through the normal image contract: the
  agent claims it, finds no trusted digest, and rejects execution with
  `EDGE_IMAGE_CONTRACT_MISSING`. The project is not left blocked.
- This is idempotent — a job already demoted is not demoted or re-evented
  again.

Pre-existing `deployment.edge_build_demoted` events are therefore the record of
a build that was abandoned because the feature was switched off, not a build
failure. Use the build and execution retry budgets (not this event) to judge
build reliability.
