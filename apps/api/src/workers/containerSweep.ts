import pool from "../db/database.js";
import type { Pool, PoolClient } from "pg";
import { runCommand, type ExecResult } from "../infrastructure/process/dockerExec.js";
import {
  ADVISORY_LOCK_NAMESPACES,
  tryAcquireSessionAdvisoryLock,
  releaseSessionAdvisoryLock,
} from "../db/advisoryLock.js";
import {
  INSTALLATION_ID_LABEL,
  getInstallationId,
} from "../infrastructure/runtime/installationIdentity.js";

export const MANAGED_CONTAINER_REGEX = /^dk-p([0-9a-f]{8})-d([0-9a-f]{8})$/;

export function parseManagedContainerName(name: string): {
  valid: boolean;
  projectPrefix?: string;
  deploymentPrefix?: string;
} {
  const match = name.trim().match(MANAGED_CONTAINER_REGEX);
  if (!match) return { valid: false };
  return {
    valid: true,
    projectPrefix: match[1],
    deploymentPrefix: match[2],
  };
}

export interface DiscoveredContainer {
  name: string;
  state: string;
  createdAtMs: number;
  id: string;
  installationId?: string;
  projectPrefix: string;
  deploymentPrefix: string;
}

export type SweepDecision =
  | { action: "protect"; reason: string }
  | { action: "sweep"; reason: string; projectId: string; deploymentId?: string; releaseId?: string };

export interface ContainerSweepOptions {
  minAgeMs?: number;
  batchLimit?: number;
  dockerTimeoutMs?: number;
  dockerBinary?: string;
  installationId?: string;
}

export interface ContainerSweepSummary {
  inspected: number;
  swept: number;
  skipped: number;
  errors: number;
  locked: boolean;
  reasons: Record<string, number>;
}

export interface ContainerSweepDeps {
  pool?: Pool;
  dockerBinary?: string;
  runFn?: typeof runCommand;
  now?: () => number;
  options?: ContainerSweepOptions;
}

const DEFAULT_MIN_AGE_MS = 300_000; // 5 minutes
const DEFAULT_BATCH_LIMIT = 25;
const DEFAULT_DOCKER_TIMEOUT_MS = 15_000;

export function parseDockerLsLine(line: string, nowMs: number): DiscoveredContainer | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("\t");
  if (parts.length < 3) return null;

  const [name, state, rawCreatedAt, id = "", rawInstallationId = ""] = parts;
  const parsed = parseManagedContainerName(name);
  if (!parsed.valid || !parsed.projectPrefix || !parsed.deploymentPrefix) {
    return null;
  }

  let createdAtMs = Date.parse(rawCreatedAt);
  if (Number.isNaN(createdAtMs)) {
    const cleaned = rawCreatedAt.replace(/ \+[0-9]{4} UTC$/, "Z").replace(" ", "T");
    createdAtMs = Date.parse(cleaned);
    if (Number.isNaN(createdAtMs)) {
      createdAtMs = nowMs;
    }
  }

  const trimmedInstallationId = rawInstallationId.trim();

  return {
    name,
    state: state.toLowerCase(),
    createdAtMs,
    id: id.trim(),
    installationId: trimmedInstallationId || undefined,
    projectPrefix: parsed.projectPrefix,
    deploymentPrefix: parsed.deploymentPrefix,
  };
}

export async function checkCandidateActiveOrInFlight(
  client: PoolClient | Pool,
  projectId: string,
  deploymentId?: string
): Promise<boolean> {
  if (deploymentId) {
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM deployments d
       LEFT JOIN deployment_jobs dj ON dj.deployment_id = d.id
       LEFT JOIN releases r ON r.deployment_id = d.id
       WHERE d.id = $1
         AND (
           d.status IN ('queued', 'building', 'deploying', 'active')
           OR r.status = 'active'
           OR (dj.lease_expires_at IS NOT NULL AND dj.lease_expires_at > NOW())
         )`,
      [deploymentId]
    );
    if (Number(res.rows[0]?.count ?? 0) > 0) return true;
  }

  const projRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM releases r
     WHERE r.project_id = $1
       AND r.status = 'active'
       AND ($2::uuid IS NULL OR r.deployment_id = $2::uuid)`,
    [projectId, deploymentId ?? null]
  );
  if (Number(projRes.rows[0]?.count ?? 0) > 0) return true;

  return false;
}

export async function classifyContainer(
  container: DiscoveredContainer,
  clientOrPool: Pool | PoolClient,
  nowMs: number,
  minAgeMs: number,
  expectedInstallationId: string = getInstallationId()
): Promise<SweepDecision> {
  // 1. Installation Ownership Verification via Container Label:
  if (!container.installationId) {
    return { action: "protect", reason: "missing_installation_label" };
  }
  if (container.installationId !== expectedInstallationId) {
    return { action: "protect", reason: "mismatched_installation_id" };
  }

  // 2. Age as Safety Filter: if inside grace period, strictly protect
  const ageMs = nowMs - container.createdAtMs;
  if (ageMs < minAgeMs) {
    return { action: "protect", reason: "in_grace_period" };
  }

  // 3. Query database with LIMIT 2 for ambiguous prefixes:
  const projRes = await clientOrPool.query<{ id: string }>(
    `SELECT id FROM projects WHERE id::text LIKE ($1 || '%') LIMIT 2`,
    [container.projectPrefix]
  );
  if (projRes.rows.length > 1) {
    return { action: "protect", reason: "ambiguous_project_prefix" };
  }

  const depRes = await clientOrPool.query<{
    id: string;
    project_id: string;
    status: string;
    release_id: string | null;
    job_status: string | null;
    lease_expires_at: Date | null;
  }>(
    `SELECT d.id, d.project_id, d.status, d.release_id,
            j.status AS job_status, j.lease_expires_at
     FROM deployments d
     LEFT JOIN deployment_jobs j ON j.deployment_id = d.id
     WHERE d.id::text LIKE ($1 || '%')
     LIMIT 2`,
    [container.deploymentPrefix]
  );
  if (depRes.rows.length > 1) {
    return { action: "protect", reason: "ambiguous_deployment_prefix" };
  }

  const riRes = await clientOrPool.query<{
    id: string;
    release_id: string;
    status: string;
    rel_status: string | null;
  }>(
    `SELECT ri.id, ri.release_id, ri.status, r.status AS rel_status
     FROM runtime_instances ri
     JOIN releases r ON r.id = ri.release_id
     WHERE ri.container_name = $1
     LIMIT 1`,
    [container.name]
  );

  const project = projRes.rows[0];
  const deployment = depRes.rows[0];
  const runtimeInstance = riRes.rows[0];

  // 4. Multi-Installation & Unverified Ownership Protection:
  if (!project && !deployment) {
    return { action: "protect", reason: "foreign_installation" };
  }

  if (project && deployment && deployment.project_id !== project.id) {
    return { action: "protect", reason: "mismatched_ownership" };
  }

  if (!deployment && !runtimeInstance) {
    return { action: "protect", reason: "unverified_ownership" };
  }

  const resolvedProjectId = project?.id ?? deployment?.project_id;
  if (!resolvedProjectId) {
    return { action: "protect", reason: "unverified_ownership" };
  }

  // 5. In-Flight & Active Protections (regardless of age):
  if (runtimeInstance?.rel_status === "active") {
    return { action: "protect", reason: "active_release" };
  }

  if (deployment?.release_id) {
    const relRes = await clientOrPool.query<{ status: string }>(
      `SELECT status FROM releases WHERE id = $1`,
      [deployment.release_id]
    );
    if (relRes.rows[0]?.status === "active") {
      return { action: "protect", reason: "active_release" };
    }
  }

  // Check active job lease
  if (deployment?.lease_expires_at && new Date(deployment.lease_expires_at).getTime() > nowMs) {
    return { action: "protect", reason: "active_job_lease" };
  }

  // Check in-flight deployment status
  if (
    deployment &&
    (deployment.status === "queued" ||
      deployment.status === "building" ||
      deployment.status === "deploying" ||
      deployment.status === "active")
  ) {
    return { action: "protect", reason: "in_flight_deployment" };
  }

  // 6. Sweepable Categories (retaining exact UUIDs):
  if (runtimeInstance) {
    if (runtimeInstance.rel_status === "stopped") {
      return { action: "sweep", reason: "release_superseded", projectId: resolvedProjectId, releaseId: runtimeInstance.release_id, deploymentId: deployment?.id };
    }
    if (runtimeInstance.rel_status === "failed") {
      return { action: "sweep", reason: "release_failed", projectId: resolvedProjectId, releaseId: runtimeInstance.release_id, deploymentId: deployment?.id };
    }
    if (deployment?.status === "cancelled") {
      return { action: "sweep", reason: "deployment_cancelled", projectId: resolvedProjectId, deploymentId: deployment.id };
    }
    if (deployment?.status === "failed") {
      return { action: "sweep", reason: "unactivated_failed", projectId: resolvedProjectId, deploymentId: deployment.id };
    }
    if (runtimeInstance.status === "starting" || runtimeInstance.status === "unhealthy") {
      return { action: "sweep", reason: "unactivated_stale", projectId: resolvedProjectId, releaseId: runtimeInstance.release_id, deploymentId: deployment?.id };
    }
    return { action: "sweep", reason: "runtime_stopped", projectId: resolvedProjectId, releaseId: runtimeInstance.release_id, deploymentId: deployment?.id };
  }

  if (deployment) {
    if (deployment.status === "failed") {
      return { action: "sweep", reason: "unactivated_crash_orphan", projectId: resolvedProjectId, deploymentId: deployment.id };
    }
    if (deployment.status === "cancelled") {
      return { action: "sweep", reason: "deployment_cancelled", projectId: resolvedProjectId, deploymentId: deployment.id };
    }
  }

  return { action: "protect", reason: "unmatched_state" };
}

export async function sweepUnactivatedContainers(
  deps: ContainerSweepDeps = {}
): Promise<ContainerSweepSummary> {
  const dbPool = deps.pool ?? pool;
  const dockerBinary = deps.dockerBinary ?? process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker";
  const run = deps.runFn ?? runCommand;
  const now = deps.now ?? (() => Date.now());
  const options = deps.options ?? {};
  const minAgeMs = options.minAgeMs ?? Number(process.env.DEPLOYKIT_CONTAINER_SWEEP_MIN_AGE_MS ?? DEFAULT_MIN_AGE_MS);
  const batchLimit = options.batchLimit ?? Number(process.env.DEPLOYKIT_CONTAINER_SWEEP_BATCH_LIMIT ?? DEFAULT_BATCH_LIMIT);
  const dockerTimeoutMs = options.dockerTimeoutMs ?? Number(process.env.DEPLOYKIT_CONTAINER_SWEEP_DOCKER_TIMEOUT_MS ?? DEFAULT_DOCKER_TIMEOUT_MS);
  const expectedInstallationId = options.installationId ?? getInstallationId();

  const summary: ContainerSweepSummary = {
    inspected: 0,
    swept: 0,
    skipped: 0,
    errors: 0,
    locked: false,
    reasons: {},
  };

  const recordReason = (reason: string) => {
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  };

  let client: PoolClient;
  try {
    client = await dbPool.connect();
  } catch (err) {
    summary.errors++;
    return summary;
  }

  const sweepLockKey = "worker-container-sweep";
  let lockAcquired = false;

  try {
    lockAcquired = await tryAcquireSessionAdvisoryLock(
      client,
      ADVISORY_LOCK_NAMESPACES.CONTAINER_SWEEP,
      sweepLockKey
    );

    if (!lockAcquired) {
      summary.locked = true;
      return summary;
    }

    let lsResult: ExecResult;
    try {
      lsResult = await run(
        dockerBinary,
        [
          "container",
          "ls",
          "-a",
          "--filter",
          "label=io.deploykit.managed=true",
          "--format",
          `{{.Names}}\t{{.State}}\t{{.CreatedAt}}\t{{.ID}}\t{{.Label "${INSTALLATION_ID_LABEL}"}}`,
        ],
        dockerTimeoutMs
      );
    } catch (error) {
      summary.errors++;
      return summary;
    }

    if (lsResult.code !== 0) {
      summary.errors++;
      return summary;
    }

    const nowMs = now();
    const lines = lsResult.stdout.split("\n");
    const discovered: DiscoveredContainer[] = [];

    for (const line of lines) {
      const container = parseDockerLsLine(line, nowMs);
      if (container) {
        discovered.push(container);
      }
    }

    summary.inspected = discovered.length;

    for (const container of discovered) {
      if (summary.swept >= batchLimit) {
        summary.skipped++;
        recordReason("batch_limit_reached");
        continue;
      }

      let decision: SweepDecision;
      try {
        decision = await classifyContainer(container, client, nowMs, minAgeMs, expectedInstallationId);
      } catch (classifyErr) {
        summary.errors++;
        continue;
      }

      if (decision.action === "protect") {
        summary.skipped++;
        recordReason(decision.reason);
        continue;
      }

      // Shared coordination mechanism with activateRelease & deployment transitions:
      // Uses a session advisory lock on PROJECT_ACTIVE_RELEASE for the candidate's exact projectId.
      let coordLockAcquired = false;
      try {
        coordLockAcquired = await tryAcquireSessionAdvisoryLock(
          client,
          ADVISORY_LOCK_NAMESPACES.PROJECT_ACTIVE_RELEASE,
          decision.projectId
        );
      } catch {
        summary.errors++;
        continue;
      }

      if (!coordLockAcquired) {
        summary.skipped++;
        recordReason("race_abort_active");
        continue;
      }

      try {
        // Step 1: Pre-stop state validation using exact UUIDs (not prefix matching)
        const isPreActive = await checkCandidateActiveOrInFlight(
          client,
          decision.projectId,
          decision.deploymentId
        );
        if (isPreActive) {
          summary.skipped++;
          recordReason("race_abort_active");
          continue;
        }

        // Step 2: Stop container if running or restarting
        let stopFailed = false;
        if (container.state === "running" || container.state === "restarting") {
          const stopResult = await run(
            dockerBinary,
            ["container", "stop", "-t", "5", container.name],
            dockerTimeoutMs
          ).catch(() => ({ code: 1, stderr: "stop timed out", timedOut: true, stdout: "", aborted: false }));

          if (
            stopResult.timedOut ||
            (stopResult.code !== 0 &&
              !stopResult.stderr.toLowerCase().includes("no such container") &&
              !stopResult.stderr.toLowerCase().includes("is not running"))
          ) {
            stopFailed = true;
          }
        }

        if (stopFailed) {
          summary.errors++;
          continue;
        }

        // Step 3: Revalidate state after docker stop and immediately before docker rm
        const isPostActive = await checkCandidateActiveOrInFlight(
          client,
          decision.projectId,
          decision.deploymentId
        );
        if (isPostActive) {
          summary.skipped++;
          recordReason("race_abort_active");
          continue;
        }

        // Step 4: Remove container
        const rmResult = await run(
          dockerBinary,
          ["container", "rm", "--force", container.name],
          dockerTimeoutMs
        );

        const isRemoved =
          rmResult.code === 0 ||
          rmResult.stderr.toLowerCase().includes("no such container");

        if (isRemoved) {
          summary.swept++;
          recordReason(decision.reason);

          await client.query(
            `UPDATE runtime_instances
             SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
             WHERE container_name = $1 AND status != 'stopped'`,
            [container.name]
          ).catch(() => undefined);
        } else {
          summary.errors++;
        }
      } catch {
        summary.errors++;
      } finally {
        if (coordLockAcquired) {
          await releaseSessionAdvisoryLock(
            client,
            ADVISORY_LOCK_NAMESPACES.PROJECT_ACTIVE_RELEASE,
            decision.projectId
          ).catch(() => undefined);
        }
      }
    }
  } finally {
    if (lockAcquired) {
      await releaseSessionAdvisoryLock(
        client,
        ADVISORY_LOCK_NAMESPACES.CONTAINER_SWEEP,
        sweepLockKey
      ).catch(() => undefined);
    }
    client.release();
  }

  return summary;
}
