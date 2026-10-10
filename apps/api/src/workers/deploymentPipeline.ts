import pool from "../db/database.js";
import { withTransaction } from "../db/transaction.js";
import {
  withCheckedOutRepository,
  SourceCheckoutError,
} from "../infrastructure/git/sourceCheckout.js";
import {
  BuildxBuildExecutor,
  BuildExecutorError,
  BUILD_CACHE_TAG,
} from "../infrastructure/build/buildxBuildExecutor.js";
import type { BuildExecutor } from "../infrastructure/build/buildExecutor.js";
import { getBuildPolicy } from "../infrastructure/build/buildPolicy.js";
import {
  detectStack,
  StackDetectorError,
} from "../infrastructure/build/stackDetector.js";
import { recordDeploymentEvent } from "../deployments/deploymentEvents.js";
import {
  DockerRuntimeManager,
  RuntimeManagerError,
} from "../infrastructure/runtime/dockerRuntimeManager.js";
import {
  NginxGatewayRouter,
} from "../infrastructure/gateway/nginxGatewayRouter.js";
import type {
  RouteTarget,
  TrafficRouter,
} from "../infrastructure/gateway/trafficRouter.js";
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
import { redactForLog } from "../agents/edgeJobSchema.js";
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
  getReleaseForDeployment,
} from "../services/releaseService.js";
import {
  digestReference,
  getOptionalRegistryConfig,
  registryRepositoryForProject,
  registryTagForDeployment,
  type RegistryConfig,
} from "../infrastructure/registry/registryConfig.js";
import {
  appendOutput,
  safeAppendLog,
  type LogLevel,
  type LogSource,
} from "../services/deploymentLogService.js";

async function dlog(
  projectId: string,
  deploymentId: string,
  source: LogSource,
  level: LogLevel,
  message: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await safeAppendLog({ deploymentId, projectId, source, level, message, metadata });
}

export interface PipelineDependencies {
  buildExecutor?: BuildExecutor;
  runtimeManager?: RuntimeManager;
  trafficRouter?: TrafficRouter;
  checkout?: typeof withCheckedOutRepository;
  runtimeNetwork?: string;
  healthTimeoutMs?: number;
  routeTimeoutMs?: number;
  gatewayName?: string;
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

const RUNTIME_CONTAINER_RECORD_LOCK = 810971723;

interface DeployReleaseRequest {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  imageRepository: string;
  imageDigest: string;
  commitSha: string;
  branch: string;
  previousActiveId: string | null;
}

interface RuntimeRecordOutcome {
  duplicate: boolean;
  adoptedReleaseId: string | null;
}

export function shouldPullImage(
  imageRepository: string,
  registry: RegistryConfig | null = getOptionalRegistryConfig()
): boolean {
  if (!registry) {
    return false;
  }

  return imageRepository.startsWith(`${registry.registryHost}/`);
}

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
  } catch {}
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
    throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, `Invalid deployment transition ${from} -> ${to}`);
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
  private readonly trafficRouter: TrafficRouter;
  private readonly checkout: typeof withCheckedOutRepository;
  private readonly runtimeNetwork: string;
  private readonly healthTimeoutMs: number;
  private readonly routeTimeoutMs: number;
  private readonly gatewayName: string;

  constructor(deps: PipelineDependencies = {}) {
    this.buildExecutor =
      deps.buildExecutor ?? new BuildxBuildExecutor();
    this.runtimeManager =
      deps.runtimeManager ?? new DockerRuntimeManager();
    this.trafficRouter =
      deps.trafficRouter ?? new NginxGatewayRouter();
    this.checkout = deps.checkout ?? withCheckedOutRepository;
    this.runtimeNetwork =
      deps.runtimeNetwork ??
      process.env.DEPLOYKIT_RUNTIME_NETWORK ??
      "deploykit-runtime";
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 60_000;
    this.routeTimeoutMs = deps.routeTimeoutMs ?? 30_000;
    const gatewayName = (
      deps.gatewayName ??
      process.env.DEPLOYKIT_GATEWAY_CONTAINER ??
      "dk-gateway"
    ).trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(gatewayName)) {
      throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, "Invalid gateway container name");
    }
    this.gatewayName = gatewayName;
  }

  async execute(
    context: DeploymentExecutionContext
  ): Promise<DeploymentExecutionResult> {
    const row = await getDeploymentRow(context.deploymentId);
    if (!row) {
      throw new PipelineError("DEPLOYMENT_NOT_FOUND", "Deployment not found");
    }
    if (row.status === "cancelled") {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
        "Deployment was cancelled",
        { retryable: false }
      );
    }
    if (row.status === "active") {
      throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, `Deployment is already ${row.status}`);
    }

    if (row.trigger === "rollback") {
      return this.executeRollback(context, row);
    }
    await dlog(
      row.project_id as string,
      context.deploymentId,
      "worker",
      "info",
      `worker claimed deployment (attempt ${context.attempt}/${context.maxAttempts})`
    );
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
    await dlog(projectId, context.deploymentId, "system", "info", "rollback started from stored digest");

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
      throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, `Cannot continue rollback from status ${rolledBack.status}`);
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

    const existingRelease = await getReleaseForDeployment(
      context.deploymentId
    );
    if (existingRelease && existingRelease.status === "failed") {
      await pool.query(`DELETE FROM releases WHERE id = $1`, [
        existingRelease.id,
      ]);
    } else if (existingRelease) {
      return this.resumeRelease(context, {
        projectId,
        releaseId: existingRelease.id,
        imageRepository: existingRelease.image_repository,
        imageDigest: existingRelease.image_digest,
        commitSha: existingRelease.commit_sha,
        branch: existingRelease.branch ?? branch,
      });
    }

    let result: DeploymentExecutionResult;
    const registry = getOptionalRegistryConfig();
    try {
      await this.assertNotCancelled(context.deploymentId, context.signal);
      await dlog(projectId, context.deploymentId, "git", "info", `cloning repository branch '${branch}'`);
      result = await this.checkout(
        {
          repositoryUrl,
          branch,
          targetCommitSha: pinnedSha,
          authToken,
          signal: context.signal,
          onLog: (e) => {
            void safeAppendLog({
              deploymentId: context.deploymentId,
              projectId,
              source: "git",
              level: e.level,
              message: e.message,
            });
          },
        },
        async ({ commitSha, workspace }) => {
          await this.assertNotCancelled(context.deploymentId, context.signal);
          await dlog(projectId, context.deploymentId, "git", "info", `checkout complete at ${commitSha.slice(0, 12)}`);
          await this.runPreflight(projectId, context.deploymentId, workspace, context.signal);
          const policy = getBuildPolicy();
          const imageRepository = registry
            ? registryRepositoryForProject(registry, projectId)
            : `deploykit/project-${shortId(projectId)}`;
          const imageTag = registry
            ? registryTagForDeployment(context.deploymentId, commitSha)
            : `d-${shortId(context.deploymentId)}-${commitSha.slice(0, 7).toLowerCase()}`;
          if (registry) {
            await this.ensureStatus(
              context.deploymentId,
              ["building"],
              "pushing",
              "deployment.push_started",
              "Build output will be pushed to the image registry"
            );
          }
          await dlog(
            projectId,
            context.deploymentId,
            "build",
            "info",
            `build started (${registry ? "push" : "load"} ${imageRepository}:${imageTag})`
          );
          const buildLines: string[] = [];
          let build;
          try {
            build = await this.buildExecutor.build({
              workspace,
              imageRepository,
              imageTag,
              commitSha,
              policy,
              push: registry !== null,
              cacheTag: registry ? BUILD_CACHE_TAG : undefined,
              signal: context.signal,
              onLog: (line) => {
                if (buildLines.length < 500) buildLines.push(line);
              },
            });
          } catch (error) {

            if (buildLines.length > 0) {
              await appendOutput({
                deploymentId: context.deploymentId,
                projectId,
                source: "build",
                level: "info",
                output: buildLines.join("\n"),
              });
            }
            if (error instanceof BuildExecutorError) {
              if (error.code === "BUILD_CANCELLED" || context.signal?.aborted) {
                await dlog(projectId, context.deploymentId, "build", "warn", "build cancelled");
                throw new PipelineError(
                  PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
                  "Deployment was cancelled during build",
                  { retryable: false }
                );
              }
              if (error.details) {
                await appendOutput({
                  deploymentId: context.deploymentId,
                  projectId,
                  source: "build",
                  level: "error",
                  output: error.details.slice(0, 8000),
                });
              }
              await dlog(projectId, context.deploymentId, "build", "error", `build failed: ${error.code}`);
              throw new PipelineError(
                error.code === "BUILD_TIMEOUT"
                  ? PIPELINE_ERROR_CODES.BUILD_TIMEOUT
                  : PIPELINE_ERROR_CODES.BUILD_FAILED,
                redactForLog(error.message),
                {
                  retryable: error.code === "BUILD_TIMEOUT",
                  details: error.details?.slice(0, 2000),
                }
              );
            }
            if (context.signal?.aborted) {
              throw new PipelineError(
                PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
                "Deployment was cancelled during build",
                { retryable: false }
              );
            }
            throw error;
          }

          await this.assertNotCancelled(context.deploymentId, context.signal);
          if (buildLines.length > 0) {
            await appendOutput({
              deploymentId: context.deploymentId,
              projectId,
              source: "build",
              level: "info",
              output: buildLines.join("\n"),
            });
          }
          await dlog(
            projectId,
            context.deploymentId,
            "build",
            "info",
            `build complete: ${build.imageDigest.slice(0, 19)}`
          );

          const cur = await getDeploymentRow(context.deploymentId);
          if (cur.status !== "verifying") {
            await setDeploymentStatus(
              context.deploymentId,
              cur.status,
              "verifying",
              registry
                ? "deployment.image_pushed"
                : "deployment.build_succeeded",
              registry
                ? "Image pushed; immutable digest recorded"
                : "Build succeeded; image digest recorded",
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
          } else {
            await pool.query(
              `
              UPDATE deployments
              SET commit_sha = $2, image_repository = $3, image_digest = $4,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
              `,
              [context.deploymentId, commitSha.toLowerCase(), imageRepository, build.imageDigest]
            );
          }

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
        if (error.code === "GIT_CANCELLED" || context.signal?.aborted) {
          await dlog(projectId, context.deploymentId, "git", "warn", "checkout cancelled");
          throw new PipelineError(
            PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
            "Deployment was cancelled during source checkout",
            { retryable: false }
          );
        }
        await dlog(projectId, context.deploymentId, "git", "error", `checkout failed: ${redactForLog(error.message).slice(0, 500)}`);
        throw new PipelineError(
          PIPELINE_ERROR_CODES.CLONE_FAILED,
          redactForLog(error.message),
          { retryable: false }
        );
      }
      if (context.signal?.aborted) {
        throw new PipelineError(
          PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
          "Deployment was cancelled",
          { retryable: false }
        );
      }
      throw error;
    }
    return result!;
  }

  private async resumeRelease(
    context: DeploymentExecutionContext,
    input: {
      projectId: string;
      releaseId: string;
      imageRepository: string;
      imageDigest: string;
      commitSha: string;
      branch: string;
    }
  ): Promise<DeploymentExecutionResult> {
    await this.ensureStatus(
      context.deploymentId,
      ["cloning", "queued"],
      "building",
      "deployment.build_resumed",
      "Resuming deployment with existing release"
    );
    const cur = await getDeploymentRow(context.deploymentId);
    if (cur.status === "building") {
      await setDeploymentStatus(
        context.deploymentId,
        cur.status,
        "verifying",
        "deployment.build_resumed",
        "Resuming deployment with existing release",
        {
          commitSha: input.commitSha,
          imageDigest: input.imageDigest,
        },
        {
          commit_sha: input.commitSha.toLowerCase(),
          image_repository: input.imageRepository,
          image_digest: input.imageDigest,
        }
      );
    } else if (
      cur.status !== "verifying" &&
      cur.status !== "deploying"
    ) {
      throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, `Cannot resume deployment from status ${cur.status}`);
    }
    const previousActive = await getActiveRelease(input.projectId);
    return this.deployRelease(context, {
      projectId: input.projectId,
      deploymentId: context.deploymentId,
      releaseId: input.releaseId,
      imageRepository: input.imageRepository,
      imageDigest: input.imageDigest,
      commitSha: input.commitSha,
      branch: input.branch,
      previousActiveId: previousActive?.id ?? null,
    });
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
      return undefined;
    }
  }

  private async runPreflight(
    projectId: string,
    deploymentId: string,
    workspace: string,
    signal?: AbortSignal
  ): Promise<void> {
    await dlog(projectId, deploymentId, "build", "info", "preflight started");
    const emit = async (
      failed: boolean,
      message: string,
      metadata: Record<string, unknown> = {}
    ): Promise<void> => {
      try {
        const cur = await getDeploymentRow(deploymentId);
        const status = (cur?.status ?? "building") as DeploymentStatus;
        await withTransaction(async (client) => {
          await recordDeploymentEvent(client, {
            deploymentId,
            eventType: failed
              ? "deployment.preflight_failed"
              : "deployment.preflight_passed",
            statusFrom: status,
            statusTo: status,
            message,
            metadata,
          });
        });
      } catch {
      }
    };
    const fail = async (code: string, message: string, metadata: Record<string, unknown> = {}): Promise<never> => {
      await dlog(projectId, deploymentId, "build", "error", `preflight failed: ${message}`);
      await emit(true, `Preflight failed: ${message}`, { code, ...metadata });
      throw new PipelineError(code, message, { retryable: false });
    };
    if (signal?.aborted) {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
        "Deployment was cancelled during preflight",
        { retryable: false }
      );
    }
    let detection;
    try {
      detection = detectStack(workspace);
    } catch (error) {
      if (error instanceof StackDetectorError) {
        await fail(error.code, error.message);
      }
      throw error;
    }
    if (detection.kind !== "dockerfile") {
      await fail(
        PIPELINE_ERROR_CODES.PREFLIGHT_NEEDS_CONFIG,
        detection.detail,
        { stack: detection.kind }
      );
    }
    await dlog(projectId, deploymentId, "build", "info", `preflight passed: ${detection.detail}`);
    await emit(false, `Preflight passed: ${detection.detail}`, { stack: detection.kind });
  }

  private async assertNotCancelled(deploymentId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
        "Deployment was cancelled",
        { retryable: false }
      );
    }
    const cur = await getDeploymentRow(deploymentId);
    if (cur?.status === "cancelled") {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
        "Deployment was cancelled",
        { retryable: false }
      );
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
      throw new PipelineError("DEPLOYMENT_NOT_FOUND", "Deployment not found");
    }
    if (cur.status === to) {
      return;
    }
    if (!allowedFrom.includes(cur.status)) {
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

  private async recordRuntimeInstance(
    input: DeployReleaseRequest,
    runtime: RuntimeInfo
  ): Promise<RuntimeRecordOutcome> {
    return withTransaction(async (client) => {
      if (runtime.containerId) {
        await client.query(
          `SELECT pg_advisory_xact_lock($1, hashtext($2))`,
          [RUNTIME_CONTAINER_RECORD_LOCK, runtime.containerId]
        );
        const existing = await client.query(
          `SELECT id, release_id FROM runtime_instances WHERE container_id = $1`,
          [runtime.containerId]
        );
        const winner = existing.rows[0] as
          | { id: string; release_id: string }
          | undefined;
        if (winner && winner.release_id !== input.releaseId) {
          return {
            duplicate: true,
            adoptedReleaseId: winner.release_id,
          };
        }
      }
      await client.query(
        `
        INSERT INTO runtime_instances (
          release_id, status, container_name, container_id,
          container_port, host_port, ip_address, health_path, started_at
        )
        VALUES ($1,'starting',$2,$3,$4,$4,$6,$5, CURRENT_TIMESTAMP)
        ON CONFLICT (container_name)
        DO UPDATE SET release_id = EXCLUDED.release_id,
                      container_id = EXCLUDED.container_id,
                      status = 'starting',
                      ip_address = EXCLUDED.ip_address,
                      started_at = CURRENT_TIMESTAMP
        `,
        [
          input.releaseId,
          runtime.containerName,
          runtime.containerId,
          runtime.containerPort,
          RUNTIME_DEFAULTS.healthPath,
          runtime.ipAddress,
        ]
      );
      return { duplicate: false, adoptedReleaseId: null };
    });
  }

  private async convergeDuplicateExecution(
    input: DeployReleaseRequest,
    runtime: RuntimeInfo,
    adoptedReleaseId: string
  ): Promise<DeploymentExecutionResult> {
    await dlog(
      input.projectId,
      input.deploymentId,
      "runtime",
      "info",
      `duplicate execution converged onto release ${adoptedReleaseId}; yielding`
    );

    await this.runtimeManager.remove(runtime.containerName).catch(() => undefined);
    const releaseRow = await pool.query(
      `SELECT status FROM releases WHERE id = $1`,
      [input.releaseId]
    );
    const releaseStatus = releaseRow.rows[0]?.status as string | undefined;
    if (
      releaseStatus === "pending" ||
      releaseStatus === "starting" ||
      releaseStatus === "healthy"
    ) {
      await markRelease(input.releaseId, "failed", {
        code: "DUPLICATE_EXECUTION_CONVERGED",
        message: `Duplicate execution converged onto release ${adoptedReleaseId}`,
      });
    }
    const depRow = await getDeploymentRow(input.deploymentId);
    if (
      depRow &&
      canTransition(depRow.status as DeploymentStatus, "failed")
    ) {
      await setDeploymentStatus(
        input.deploymentId,
        depRow.status as string,
        "failed",
        "deployment.duplicate_converged",
        "Duplicate execution converged onto an existing runtime",
        { adoptedReleaseId },
        {
          error_code: "DUPLICATE_EXECUTION_CONVERGED",
          error_message: `Duplicate execution converged onto release ${adoptedReleaseId}`,
        }
      );
    }
    return {
      commitSha: input.commitSha.toLowerCase(),
      imageRepository: input.imageRepository,
      imageDigest: input.imageDigest,
      duplicateConverged: { adoptedReleaseId },
    };
  }

  private async deployRelease(
    context: DeploymentExecutionContext,
    input: DeployReleaseRequest
  ): Promise<DeploymentExecutionResult> {
    await this.assertNotCancelled(input.deploymentId, context.signal);
    const containerName =
      `dk-p${shortId(input.projectId)}-d${shortId(input.deploymentId)}`;
    const imageRef = `${input.imageRepository}@${input.imageDigest}`;
    let runtime: RuntimeInfo | null = null;

    const storedRelease = await pool.query(
      `SELECT status FROM releases WHERE id = $1`,
      [input.releaseId]
    );
    const storedStatus = storedRelease.rows[0]?.status as string | undefined;
    if (storedStatus === "failed") {
      throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, "Release is marked failed and cannot be deployed");
    }
    const needsMarking =
      storedStatus !== "healthy" && storedStatus !== "active";

    if (shouldPullImage(input.imageRepository)) {
      await dlog(input.projectId, input.deploymentId, "registry", "info", `pulling ${input.imageRepository}@${input.imageDigest.slice(0, 19)}`);
      try {
        await this.runtimeManager.pull(
          digestReference(input.imageRepository, input.imageDigest),
          context.signal
        );
        await dlog(input.projectId, input.deploymentId, "registry", "info", "image pull complete");
      } catch (error) {
        if (
          (error instanceof RuntimeManagerError && error.code === "RUNTIME_CANCELLED") ||
          context.signal?.aborted
        ) {
          throw new PipelineError(
            PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
            "Deployment was cancelled during image pull",
            { retryable: false }
          );
        }
        const retryable =
          error instanceof RuntimeManagerError &&
          (error.code === "DOCKER_TIMEOUT" ||
            /timeout|refused|unavailable/i.test(
              error instanceof Error ? error.message : ""
            ));
        throw new PipelineError(
          PIPELINE_ERROR_CODES.RUNTIME_FAILED,
          error instanceof Error
            ? `Image pull failed: ${redactForLog(error.message).slice(0, 300)}`
            : "Image pull failed",
          { retryable }
        );
      }
    }

    await this.assertNotCancelled(input.deploymentId, context.signal);

    const containerPort = await discoverExposedPort(imageRef);
    await dlog(input.projectId, input.deploymentId, "runtime", "info", `starting container ${containerName} on port ${containerPort}`);

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
      runtime = await this.runtimeManager.inspect(
        runtime.containerName,
        this.runtimeNetwork
      );
      const record = await this.recordRuntimeInstance(input, runtime);
      if (record.duplicate && record.adoptedReleaseId) {
        return this.convergeDuplicateExecution(
          input,
          runtime,
          record.adoptedReleaseId
        );
      }
      if (needsMarking) {
        await markRelease(input.releaseId, "starting");
      }

      try {
        await this.runtimeManager.waitForHealthy(
          runtime,
          this.healthTimeoutMs,
          context.signal
        );
        await dlog(input.projectId, input.deploymentId, "healthcheck", "info", `health check passed on port ${runtime.containerPort}`);
      } catch (error) {
        if (
          (error instanceof RuntimeManagerError && error.code === "RUNTIME_CANCELLED") ||
          context.signal?.aborted
        ) {
          throw new PipelineError(
            PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
            "Deployment was cancelled during health verification",
            { retryable: false }
          );
        }
        throw new PipelineError(
          PIPELINE_ERROR_CODES.HEALTH_CHECK_FAILED,
          error instanceof Error
            ? redactForLog(error.message)
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
      if (needsMarking) {
        await markRelease(input.releaseId, "healthy");
      }

      await this.assertNotCancelled(input.deploymentId, context.signal);

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

      try {
        await activateRelease(
          input.projectId,
          input.releaseId,
          input.deploymentId,
          {
            gatewayName: this.gatewayName,
            containerName: runtime.containerName,
            containerIp: runtime.ipAddress,
            containerPort: runtime.containerPort,
          }
        );
      } catch (error) {
        throw new PipelineError(PIPELINE_ERROR_CODES.ACTIVATION_FAILED, error instanceof Error ? redactForLog(error.message) : "Activation failed");
      }

      const route: RouteTarget = {
        projectId: input.projectId,
        releaseId: input.releaseId,
        containerName: runtime.containerName,
        containerIp: runtime.ipAddress,
        containerPort: runtime.containerPort,
      };
      let verifiedDomains: string[] = [];
      try {
        const { getVerifiedDomains } = await import("../services/domainService.js");
        verifiedDomains = await getVerifiedDomains(input.projectId);
      } catch {
        verifiedDomains = [];
      }
      let tlsEntries: import("../infrastructure/gateway/trafficRouter.js").TlsRouteEntry[] = [];
      try {
        const { resolveValidTlsEntries } = await import("../services/gatewayService.js");
        tlsEntries = await resolveValidTlsEntries(input.projectId);
      } catch {
        tlsEntries = [];
      }
      let previousRaw: string | null = null;
      const maybeRaw = this.trafficRouter as unknown as {
        readRawConfig?: (id: string) => Promise<string | null>;
      };
      if (typeof maybeRaw.readRawConfig === "function") {
        try {
          previousRaw = await maybeRaw.readRawConfig(input.projectId);
        } catch {
          previousRaw = null;
        }
      }
      try {
        await this.trafficRouter.sync(route, verifiedDomains, tlsEntries);
        await this.trafficRouter.verifyRoute(route, this.routeTimeoutMs);
        if (typeof this.trafficRouter.verifyHttpsRoute === "function") {
          for (const entry of tlsEntries) {
            await this.trafficRouter.verifyHttpsRoute(
              route,
              entry.domain,
              Math.min(this.routeTimeoutMs, 10_000)
            );
          }
        }
        await dlog(input.projectId, input.deploymentId, "gateway", "info", "traffic switched to new release");
      } catch (error) {
        const restorable = this.trafficRouter as unknown as {
          restoreRawConfig?: (id: string, prev: string | null) => Promise<void>;
        };
        if (typeof restorable.restoreRawConfig === "function") {
          await restorable
            .restoreRawConfig(input.projectId, previousRaw)
            .catch(() => undefined);
        } else {
          await this.trafficRouter.sync(route).catch(() => undefined);
        }
        throw new PipelineError(
          PIPELINE_ERROR_CODES.ACTIVATION_FAILED,
          error instanceof Error
            ? `Traffic switch failed: ${redactForLog(error.message).slice(0, 300)}`
            : "Traffic switch failed",
          { retryable: true }
        );
      }

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

      if (runtime) {
        try {
          const tail = await this.runtimeManager.containerLogs?.(runtime.containerName, 100);
          if (tail && tail.trim()) {
            await appendOutput({
              deploymentId: input.deploymentId,
              projectId: input.projectId,
              source: "runtime",
              level: "error",
              output: tail,
            });
          }
        } catch {
        }
        const msg = error instanceof Error ? redactForLog(error.message).slice(0, 500) : String(error).slice(0, 500);
        await dlog(input.projectId, input.deploymentId, "runtime", "error", `runtime failed: ${msg}`);
      }
      const releaseRow = await pool
        .query(`SELECT status FROM releases WHERE id = $1`, [input.releaseId])
        .catch(() => null);
      const releaseActive = releaseRow?.rows[0]?.status === "active";
      if (runtime && !releaseActive) {
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
      if (!releaseActive) {
        await markRelease(input.releaseId, "failed", {
          code:
            error instanceof PipelineError
              ? error.code
              : "RUNTIME_FAILED",
          message:
            error instanceof Error ? redactForLog(error.message) : String(error),
        }).catch(() => undefined);
      }
      if (
        releaseActive &&
        error instanceof PipelineError &&
        error.code === PIPELINE_ERROR_CODES.ACTIVATION_FAILED &&
        context.attempt >= context.maxAttempts
      ) {
        try {
          const { reconcileProjectGateway } = await import("../services/gatewayService.js");
          const reconciled = await reconcileProjectGateway(input.projectId, {
            router: this.trafficRouter,
            timeoutMs: this.routeTimeoutMs,
          });
          await dlog(
            input.projectId,
            input.deploymentId,
            "gateway",
            "info",
            `gateway recovery ${reconciled.status} for release ${reconciled.releaseId ?? "none"}`
          );
        } catch (reconcileError) {
          await dlog(
            input.projectId,
            input.deploymentId,
            "gateway",
            "warn",
            `gateway recovery failed and will retry on worker restart: ${
              reconcileError instanceof Error
                ? reconcileError.message.slice(0, 300)
                : "unknown error"
            }`
          );
        }
      }
      if (
        error instanceof PipelineError ||
        error instanceof RuntimeManagerError
      ) {
        if (error instanceof RuntimeManagerError && error.code === "RUNTIME_CANCELLED") {
          throw new PipelineError(
            PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
            "Deployment was cancelled",
            { retryable: false }
          );
        }
        throw error instanceof PipelineError
          ? error
          : new PipelineError(
              PIPELINE_ERROR_CODES.RUNTIME_FAILED,
              error.message,
              { retryable: false }
            );
      }
      if (context.signal?.aborted) {
        throw new PipelineError(
          PIPELINE_ERROR_CODES.DEPLOYMENT_CANCELLED,
          "Deployment was cancelled",
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
