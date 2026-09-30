import pool from "../db/database.js";
import {
  withCheckedOutRepository,
  SourceCheckoutError,
} from "../infrastructure/git/sourceCheckout.js";
import {
  BuildxBuildExecutor,
  BuildExecutorError,
} from "../infrastructure/build/buildxBuildExecutor.js";
import type { BuildExecutor } from "../infrastructure/build/buildExecutor.js";
import { getBuildPolicy } from "../infrastructure/build/buildPolicy.js";
import {
  DockerRuntimeManager,
  RuntimeManagerError,
} from "../infrastructure/runtime/dockerRuntimeManager.js";
import type {
  RuntimeManager,
  RuntimeInfo,
} from "../infrastructure/runtime/runtimeManager.js";
import {
  canTransition,
  type DeploymentStatus,
} from "../deployments/deploymentStateMachine.js";
import {
  PipelineError,
  PIPELINE_ERROR_CODES,
} from "../deployments/deploymentErrors.js";
import type {
  DeploymentExecutor,
  DeploymentExecutionContext,
  DeploymentExecutionResult,
} from "./deploymentExecutor.js";
import {
  createRelease,
  markRelease,
  activateRelease,
  getActiveRelease,
} from "../services/releaseService.js";

export interface PipelineDependencies {
  buildExecutor?: BuildExecutor;
  runtimeManager?: RuntimeManager;
  checkout?: typeof withCheckedOutRepository;
  runtimeNetwork?: string;
  healthTimeoutMs?: number;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNTIME_DEFAULTS = {
  memoryBytes: 512 * 1024 * 1024,
  cpuLimit: 1,
  pidsLimit: 256,
  fallbackPort: 3000,
  healthPath: "/",
};

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/**
 * Inspect the built image for its first EXPOSED TCP port.
 * Falls back to the conventional default when the image exposes nothing.
 */
async function discoverExposedPort(imageRef: string): Promise<number> {
  const dockerBinary =
    process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker";
  try {
    const { stdout } = await execFileAsync(
      dockerBinary,
      ["image", "inspect", imageRef, "--format", "{{json .Config.ExposedPorts}}"],
      { timeout: 30_000, maxBuffer: 64 * 1024 }
    );
    const exposed = JSON.parse(stdout.trim() || "{}") as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(exposed)) {
      const port = Number(key.split("/")[0]);
      if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
        return port;
      }
    }
  } catch {
    // Fall through to the default port.
  }
  return RUNTIME_DEFAULTS.fallbackPort;
}

async function setDeploymentStatus(
  deploymentId: string,
  from: string,
  to: DeploymentStatus,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!canTransition(from as never, to as never)) {
    throw new PipelineError(
      PIPELINE_ERROR_CODES.ACTIVATION_FAILED,
      `Invalid deployment transition ${from} -> ${to}`
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sets = ["status = $2", "updated_at = CURRENT_TIMESTAMP"];
    const values: unknown[] = [deploymentId, to];
    let idx = 3;
    for (const [key, value] of Object.entries(extra)) {
      if (
        [
          "commit_sha",
          "image_repository",
          "image_digest",
          "error_code",
          "error_message",
        ].includes(key)
      ) {
        sets.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }
    await client.query(
      `UPDATE deployments SET ${sets.join(", ")} WHERE id = $1`,
      values
    );
    await client.query(
      `
      INSERT INTO deployment_events (
        deployment_id, event_type, status_from, status_to, message, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `,
      [
        deploymentId,
        eventType,
        from,
        to,
        message,
        JSON.stringify(metadata),
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getDeploymentRow(deploymentId: string) {
  const result = await pool.query(
    `
    SELECT d.*, p.repository_url, p.name AS project_name
    FROM deployments d
    JOIN projects p ON p.id = d.project_id
    WHERE d.id = $1
    `,
    [deploymentId]
  );
  return result.rows[0] ?? null;
}

export class RealDeploymentExecutor implements DeploymentExecutor {
  private readonly buildExecutor: BuildExecutor;
  private readonly runtimeManager: RuntimeManager;
  private readonly checkout: typeof withCheckedOutRepository;
  private readonly runtimeNetwork: string;
  private readonly healthTimeoutMs: number;

  constructor(deps: PipelineDependencies = {}) {
    this.buildExecutor =
      deps.buildExecutor ?? new BuildxBuildExecutor();
    this.runtimeManager =
      deps.runtimeManager ?? new DockerRuntimeManager();
    this.checkout = deps.checkout ?? withCheckedOutRepository;
    this.runtimeNetwork =
      deps.runtimeNetwork ??
      process.env.DEPLOYKIT_RUNTIME_NETWORK ??
      "deploykit-runtime";
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 60_000;
  }

  async execute(
    context: DeploymentExecutionContext
  ): Promise<DeploymentExecutionResult> {
    const row = await getDeploymentRow(context.deploymentId);
    if (!row) {
      throw new PipelineError("DEPLOYMENT_NOT_FOUND", "Deployment not found");
    }
    if (row.status === "cancelled" || row.status === "active") {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.ACTIVATION_FAILED,
        `Deployment is already ${row.status}`
      );
    }

    if (row.trigger === "rollback") {
      return this.executeRollback(context, row);
    }
    return this.executeBuild(context, row);
  }

  private async executeRollback(
    context: DeploymentExecutionContext,
    row: Record<string, unknown>
  ): Promise<DeploymentExecutionResult> {
    const projectId = row.project_id as string;
    const rollbackReleaseId = row.rollback_release_id as string | null;
    if (!rollbackReleaseId) {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.ROLLBACK_INVALID,
        "Rollback deployment has no target release",
        { retryable: false }
      );
    }
    const rel = await pool.query(
      `SELECT * FROM releases WHERE id = $1`,
      [rollbackReleaseId]
    );
    if (rel.rowCount === 0 || rel.rows[0].project_id !== projectId) {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.ROLLBACK_INVALID,
        "Rollback target release not found",
        { retryable: false }
      );
    }
    const target = rel.rows[0];
    if (target.status === "failed") {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.ROLLBACK_INVALID,
        "Cannot rollback to a failed release",
        { retryable: false }
      );
    }

    await this.ensureStatus(
      context.deploymentId,
      ["cloning", "queued", "building"],
      "building",
      "deployment.rollback_started",
      "Rollback started from stored digest"
    );

    // Persist immutable identity from the stored release (no rebuild).
    await pool.query(
      `
      UPDATE deployments
      SET commit_sha = $2, image_repository = $3, image_digest = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [
        context.deploymentId,
        target.commit_sha,
        target.image_repository,
        target.image_digest,
      ]
    );

    // Rollback follows the same linear path as builds: the stored digest
    // is validated here (building -> verifying), then deployRelease takes
    // verifying -> deploying after runtime health succeeds. Skipping
    // straight to deploying would violate the state machine.
    const rolledBack = await getDeploymentRow(context.deploymentId);
    if (rolledBack.status === "building") {
      await setDeploymentStatus(
        context.deploymentId,
        rolledBack.status,
        "verifying",
        "deployment.rollback_ready",
        "Rollback digest validated; creating runtime",
        {
          commitSha: target.commit_sha,
          imageDigest: target.image_digest,
          rollbackReleaseId,
        }
      );
    } else if (rolledBack.status !== "verifying") {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.ACTIVATION_FAILED,
        `Cannot continue rollback from status ${rolledBack.status}`
      );
    }

    const previousActive = await getActiveRelease(projectId);
    const release = await createRelease({
      deploymentId: context.deploymentId,
      projectId,
      imageRepository: target.image_repository,
      imageDigest: target.image_digest,
      commitSha: target.commit_sha,
      branch: (row.branch as string) ?? "main",
      supersedesReleaseId: previousActive?.id ?? null,
    });

    return this.deployRelease(context, {
      projectId,
      deploymentId: context.deploymentId,
      releaseId: release.id,
      imageRepository: target.image_repository,
      imageDigest: target.image_digest,
      commitSha: target.commit_sha,
      branch: (row.branch as string) ?? "main",
      previousActiveId: previousActive?.id ?? null,
    });
  }

  private async executeBuild(
    context: DeploymentExecutionContext,
    row: Record<string, unknown>
  ): Promise<DeploymentExecutionResult> {
    const projectId = row.project_id as string;
    const repositoryUrl = row.repository_url as string;
    const branch = (row.branch as string) ?? "main";
    const pinnedSha =
      typeof row.commit_sha === "string" && /^[0-9a-f]{40}$/i.test(row.commit_sha)
        ? (row.commit_sha as string).toLowerCase()
        : null;
    const authToken = await this.resolveGitHubToken(projectId);

    await this.ensureStatus(
      context.deploymentId,
      ["cloning", "queued"],
      "building",
      "deployment.build_started",
      "Source checkout complete; build started"
    );

    let result: DeploymentExecutionResult;
    try {
      result = await this.checkout(
        { repositoryUrl, branch, targetCommitSha: pinnedSha, authToken },
        async ({ commitSha, workspace }) => {
          const policy = getBuildPolicy();
          const imageRepository =
            `deploykit/project-${shortId(projectId)}`;
          const imageTag =
            `d-${shortId(context.deploymentId)}-${commitSha.slice(0, 7).toLowerCase()}`;
          let build;
          try {
            build = await this.buildExecutor.build({
              workspace,
              imageRepository,
              imageTag,
              commitSha,
              policy,
            });
          } catch (error) {
            if (error instanceof BuildExecutorError) {
              throw new PipelineError(
                error.code === "BUILD_TIMEOUT"
                  ? PIPELINE_ERROR_CODES.BUILD_TIMEOUT
                  : PIPELINE_ERROR_CODES.BUILD_FAILED,
                error.message,
                {
                  retryable: false,
                  details: error.details?.slice(0, 2000),
                }
              );
            }
            throw error;
          }

          // building -> verifying + persist immutable identity.
          const cur = await getDeploymentRow(context.deploymentId);
          await setDeploymentStatus(
            context.deploymentId,
            cur.status,
            "verifying",
            "deployment.build_succeeded",
            "Build succeeded; image digest recorded",
            {
              commitSha,
              imageReference: build.imageReference,
              imageDigest: build.imageDigest,
            },
            {
              commit_sha: commitSha.toLowerCase(),
              image_repository: imageRepository,
              image_digest: build.imageDigest,
            }
          );

          const previousActive =
            await getActiveRelease(projectId);
          const release = await createRelease({
            deploymentId: context.deploymentId,
            projectId,
            imageRepository,
            imageDigest: build.imageDigest,
            commitSha,
            branch,
            supersedesReleaseId: previousActive?.id ?? null,
          });

          const deployed = await this.deployRelease(context, {
            projectId,
            deploymentId: context.deploymentId,
            releaseId: release.id,
            imageRepository,
            imageDigest: build.imageDigest,
            commitSha,
            branch,
            previousActiveId: previousActive?.id ?? null,
          });
          return deployed;
        }
      );
    } catch (error) {
      if (error instanceof SourceCheckoutError) {
        throw new PipelineError(
          PIPELINE_ERROR_CODES.CLONE_FAILED,
          error.message,
          { retryable: false }
        );
      }
      throw error;
    }
    return result!;
  }

  private async resolveGitHubToken(projectId: string): Promise<string | undefined> {
    try {
      const link = await pool.query(
        `SELECT i.github_installation_id
         FROM projects p
         JOIN github_repositories r ON r.id = p.github_repository_id
         JOIN github_installations i ON i.id = r.installation_id
         WHERE p.id = $1`,
        [projectId]
      );
      const installationId = link.rows[0]?.github_installation_id;
      if (installationId === undefined || installationId === null) return undefined;
      const { getInstallationToken } = await import(
        "../infrastructure/github/githubAuth.js"
      );
      return await getInstallationToken(String(installationId));
    } catch {
      // Public repos must keep working when GitHub App is unconfigured;
      // private checkout will fail closed with CLONE_FAILED.
      return undefined;
    }
  }

  private async ensureStatus(
    deploymentId: string,
    allowedFrom: string[],
    to: DeploymentStatus,
    eventType: string,
    message: string
  ): Promise<void> {
    const cur = await getDeploymentRow(deploymentId);
    if (!cur) {
      throw new PipelineError(
        "DEPLOYMENT_NOT_FOUND",
        "Deployment not found"
      );
    }
    if (cur.status === to) {
      return;
    }
    if (!allowedFrom.includes(cur.status)) {
      // Already past this stage (retry after partial progress) — continue.
      return;
    }
    await setDeploymentStatus(
      deploymentId,
      cur.status,
      to,
      eventType,
      message,
      {}
    );
  }

  private async deployRelease(
    context: DeploymentExecutionContext,
    input: {
      projectId: string;
      deploymentId: string;
      releaseId: string;
      imageRepository: string;
      imageDigest: string;
      commitSha: string;
      branch: string;
      previousActiveId: string | null;
    }
  ): Promise<DeploymentExecutionResult> {
    const containerName =
      `dk-p${shortId(input.projectId)}-d${shortId(input.deploymentId)}`;
    const imageRef = `${input.imageRepository}@${input.imageDigest}`;
    let runtime: RuntimeInfo | null = null;

    // Discover the container's listening port from image EXPOSE metadata.
    // Hardcoding a port would health-check the wrong target for images
    // that listen elsewhere (e.g. busybox httpd on :80 vs default :3000).
    const containerPort = await discoverExposedPort(imageRef);

    // Best-effort removal of a stale container with our deterministic name.
    // The name is scoped to this deployment (dk-p<proj>-d<dep>), so a
    // same-name container can only be a leftover from an earlier attempt
    // that crashed between create and cleanup; without this, retries would
    // fail permanently on name conflict.
    await this.runtimeManager.remove(containerName).catch(() => undefined);

    try {
      const spec = {
        containerName,
        imageReference: imageRef,
        networkName: this.runtimeNetwork,
        containerPort,
        environment: {
          PORT: String(containerPort),
          DEPLOYKIT_DEPLOYMENT_ID: input.deploymentId,
        },
        healthPath: RUNTIME_DEFAULTS.healthPath,
        memoryBytes: RUNTIME_DEFAULTS.memoryBytes,
        cpuLimit: RUNTIME_DEFAULTS.cpuLimit,
        pidsLimit: RUNTIME_DEFAULTS.pidsLimit,
      };
      runtime = await this.runtimeManager.create(spec);
      await this.runtimeManager.start(runtime.containerName);
      // Inspect after start: only now does the container have an IP
      // on the runtime network.
      runtime = await this.runtimeManager.inspect(
        runtime.containerName,
        this.runtimeNetwork
      );
      await pool.query(
        `
        INSERT INTO runtime_instances (
          release_id, status, container_name, container_id,
          container_port, host_port, health_path, started_at
        )
        VALUES ($1,'starting',$2,$3,$4,$4,$5, CURRENT_TIMESTAMP)
        ON CONFLICT (container_name)
        DO UPDATE SET release_id = EXCLUDED.release_id,
                      container_id = EXCLUDED.container_id,
                      status = 'starting',
                      started_at = CURRENT_TIMESTAMP
        `,
        [
          input.releaseId,
          runtime.containerName,
          runtime.containerId,
          runtime.containerPort,
          RUNTIME_DEFAULTS.healthPath,
        ]
      );

      try {
        await this.runtimeManager.waitForHealthy(
          runtime,
          this.healthTimeoutMs
        );
      } catch (error) {
        throw new PipelineError(
          PIPELINE_ERROR_CODES.HEALTH_CHECK_FAILED,
          error instanceof Error
            ? error.message
            : "Health check failed",
          { retryable: false }
        );
      }

      await pool.query(
        `
        UPDATE runtime_instances
        SET status = 'running', last_health_check_at = CURRENT_TIMESTAMP
        WHERE release_id = $1 AND container_name = $2
        `,
        [input.releaseId, runtime.containerName]
      );
      await markRelease(input.releaseId, "healthy");

      // verifying -> deploying (runtime healthy, ready to switch).
      const cur = await getDeploymentRow(input.deploymentId);
      if (cur.status !== "deploying") {
        await setDeploymentStatus(
          input.deploymentId,
          cur.status,
          "deploying",
          "deployment.verified",
          "Runtime healthy; activating release",
          { releaseId: input.releaseId }
        );
      }

      // Transactional switch; old active preserved as stopped.
      try {
        await activateRelease(
          input.projectId,
          input.releaseId,
          input.deploymentId
        );
      } catch (error) {
        throw new PipelineError(
          PIPELINE_ERROR_CODES.ACTIVATION_FAILED,
          error instanceof Error ? error.message : "Activation failed"
        );
      }

      // Safe rollout: only now stop/remove the previous release's containers.
      if (input.previousActiveId) {
        await this.cleanupReleaseContainers(
          input.previousActiveId,
          input.releaseId
        );
      }

      return {
        commitSha: input.commitSha.toLowerCase(),
        imageRepository: input.imageRepository,
        imageDigest: input.imageDigest,
      };
    } catch (error) {
      // Cleanup owned new runtime; never touch the old active on failure.
      if (runtime) {
        await this.runtimeManager
          .remove(runtime.containerName)
          .catch(() => undefined);
        await pool
          .query(
            `UPDATE runtime_instances SET status = 'failed', stopped_at = CURRENT_TIMESTAMP WHERE release_id = $1`,
            [input.releaseId]
          )
          .catch(() => undefined);
      }
      await markRelease(input.releaseId, "failed", {
        code:
          error instanceof PipelineError
            ? error.code
            : "RUNTIME_FAILED",
        message:
          error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      if (
        error instanceof PipelineError ||
        error instanceof RuntimeManagerError
      ) {
        throw error instanceof PipelineError
          ? error
          : new PipelineError(
              PIPELINE_ERROR_CODES.RUNTIME_FAILED,
              error.message,
              { retryable: false }
            );
      }
      throw error;
    }
  }

  private async cleanupReleaseContainers(
    previousReleaseId: string,
    newReleaseId: string
  ): Promise<void> {
    const rows = await pool.query(
      `SELECT container_name FROM runtime_instances WHERE release_id = $1 AND status IN ('running','starting')`,
      [previousReleaseId]
    );
    for (const r of rows.rows) {
      const name = r.container_name as string;
      // Never destroy the new release's container even on name collision.
      const isNew = await pool.query(
        `SELECT 1 FROM runtime_instances WHERE release_id = $1 AND container_name = $2`,
        [newReleaseId, name]
      );
      if (isNew.rowCount !== 0) {
        continue;
      }
      await this.runtimeManager.stop(name).catch(() => undefined);
      await this.runtimeManager.remove(name).catch(() => undefined);
      await pool
        .query(
          `UPDATE runtime_instances SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE release_id = $1 AND container_name = $2`,
          [previousReleaseId, name]
        )
        .catch(() => undefined);
    }
  }
}
