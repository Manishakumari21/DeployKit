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
- Fresh manual edge deployments have no trusted image and fail closed;
  central builds do not run for edge targets.
- Edge release activation, traffic switching, and rollback are **not**
  implemented: a succeeded edge job means a healthy local container, not
  served traffic.
- Private registry credential delivery is **not** implemented:
  unauthenticated pulls only.
- No dashboard/rollout integration (deferred to Phase 12.6).
