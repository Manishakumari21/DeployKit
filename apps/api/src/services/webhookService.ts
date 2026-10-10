import pool from "../db/database.js";
import { validateBranch } from "../infrastructure/git/sourceCheckout.js";
import { createDeployment, DeploymentConflictError } from "./deploymentService.js";

export class WebhookError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
    this.status = status;
  }
}

export type WebhookOutcome =
  | { status: "processed"; deploymentId: string }
  | { status: "duplicate"; deploymentId?: string }
  | { status: "ignored"; reason: string };

const DELIVERY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { full_name?: unknown; id?: unknown };
  installation?: { id?: unknown };
}

function branchFromRef(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) {
    throw new WebhookError("UNSUPPORTED_REF", "Only branch pushes are supported", 202);
  }
  const branch = ref.slice(prefix.length);
  try {
    return validateBranch(branch);
  } catch {
    throw new WebhookError("INVALID_BRANCH", "Invalid branch in webhook payload", 400);
  }
}

async function markDelivery(
  deliveryId: string,
  status: string,
  patch: { deploymentId?: string; error?: string; repository?: string; installation?: number } = {}
): Promise<void> {
  await pool.query(
    `UPDATE github_webhook_deliveries
     SET status = $2, deployment_id = COALESCE($3, deployment_id),
         error = COALESCE($4, error),
         repository_full_name = COALESCE($5, repository_full_name),
         installation_id = COALESCE($6, installation_id),
         updated_at = CURRENT_TIMESTAMP,
         processed_at = CASE WHEN $2 IN ('processed','ignored','failed') THEN CURRENT_TIMESTAMP ELSE processed_at END
     WHERE delivery_id = $1`,
    [
      deliveryId,
      status,
      patch.deploymentId ?? null,
      patch.error ? patch.error.slice(0, 2000) : null,
      patch.repository ?? null,
      patch.installation ?? null,
    ]
  );
}

const PROCESSING_LEASE_MS = 5 * 60 * 1000;

async function claimDelivery(
  deliveryId: string,
  event: string
): Promise<WebhookOutcome | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [deliveryId]);
    const existing = await client.query(
      `SELECT status, deployment_id, updated_at
       FROM github_webhook_deliveries
       WHERE delivery_id = $1
       FOR UPDATE`,
      [deliveryId]
    );
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, attempts, updated_at)
         VALUES ($1, $2, 'processing', 1, CURRENT_TIMESTAMP)`,
        [deliveryId, event]
      );
      await client.query("COMMIT");
      return null;
    }
    const row = existing.rows[0] as {
      status: string;
      deployment_id: string | null;
      updated_at: Date | string;
    };
    if (row.status === "processed") {
      await client.query("COMMIT");
      return { status: "duplicate", deploymentId: row.deployment_id ?? undefined };
    }
    if (row.status === "ignored") {
      await client.query("COMMIT");
      return { status: "duplicate" };
    }
    const updatedMs = new Date(row.updated_at).getTime();
    const fresh =
      Number.isSafeInteger(updatedMs) && Date.now() - updatedMs < PROCESSING_LEASE_MS;
    if (row.status === "processing" && fresh) {
      await client.query("COMMIT");
      return { status: "duplicate" };
    }
    await client.query(
      `UPDATE github_webhook_deliveries
       SET status = 'processing', event_type = $2,
           attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
       WHERE delivery_id = $1`,
      [deliveryId, event]
    );
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function findLinkedProject(fullName: string): Promise<{
  project: Record<string, unknown>;
  repo: Record<string, unknown>;
} | null> {
  const result = await pool.query(
    `SELECT p.*, r.id AS repo_id, r.full_name AS repo_full_name,
            r.installation_id AS repo_installation_db_id,
            i.github_installation_id AS repo_installation_id
     FROM github_repositories r
     JOIN projects p ON p.github_repository_id = r.id
     LEFT JOIN github_installations i ON i.id = r.installation_id
     WHERE lower(r.full_name) = lower($1)
     LIMIT 5`,
    [fullName]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    project: row,
    repo: {
      id: row.repo_id,
      full_name: row.repo_full_name,
      installation_db_id: row.repo_installation_db_id,
      installation_id: row.repo_installation_id,
    },
  };
}

async function findLinkedProjectForBranch(
  fullName: string,
  branch: string
): Promise<{ project: Record<string, unknown>; repo: Record<string, unknown> } | null> {
  const result = await pool.query(
    `SELECT p.*, r.id AS repo_id, r.full_name AS repo_full_name,
            r.installation_id AS repo_installation_db_id,
            i.github_installation_id AS repo_installation_id
     FROM github_repositories r
     JOIN projects p ON p.github_repository_id = r.id
     LEFT JOIN github_installations i ON i.id = r.installation_id
     WHERE lower(r.full_name) = lower($1) AND p.branch = $2
     LIMIT 1`,
    [fullName, branch]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    project: row,
    repo: {
      id: row.repo_id,
      full_name: row.repo_full_name,
      installation_db_id: row.repo_installation_db_id,
      installation_id: row.repo_installation_id,
    },
  };
}

export async function handleGitHubWebhook(input: {
  deliveryId: string;
  event: string;
  rawBody: Buffer;
}): Promise<WebhookOutcome> {
  const deliveryId = (input.deliveryId ?? "").trim();
  if (!DELIVERY_PATTERN.test(deliveryId)) {
    throw new WebhookError("INVALID_DELIVERY", "Invalid delivery ID", 400);
  }
  const event = (input.event ?? "").trim().toLowerCase();
  if (!event || event.length > 64 || !/^[a-z0-9_.-]+$/.test(event)) {
    throw new WebhookError("INVALID_EVENT", "Invalid event type", 400);
  }

  const alreadyHandled = await claimDelivery(deliveryId, event);
  if (alreadyHandled) return alreadyHandled;

  let payload: PushPayload;
  try {
    payload =
      JSON.parse(input.rawBody.toString("utf8")) as PushPayload;
  } catch {
    await markDelivery(deliveryId, "failed", { error: "Malformed JSON payload" });
    throw new WebhookError("MALFORMED_PAYLOAD", "Malformed JSON payload", 400);
  }

  if (event !== "push") {
    await markDelivery(deliveryId, "ignored", { error: `Unsupported event: ${event}` });
    return { status: "ignored", reason: `unsupported_event:${event}` };
  }

  const fullName =
    typeof payload.repository?.full_name === "string"
      ? payload.repository.full_name.trim()
      : "";
  if (!fullName || fullName.length > 320) {
    await markDelivery(deliveryId, "failed", { error: "Missing repository" });
    throw new WebhookError("INVALID_REPOSITORY", "Missing repository in payload", 400);
  }
  const installationId =
    payload.installation && payload.installation.id !== undefined
      ? Number(payload.installation.id)
      : null;
  if (payload.installation !== undefined && !(Number.isSafeInteger(installationId) && (installationId as number) > 0)) {
    await markDelivery(deliveryId, "failed", { error: "Invalid installation", repository: fullName });
    throw new WebhookError("INVALID_INSTALLATION", "Invalid installation in payload", 400);
  }

  let branch: string;
  try {
    branch = branchFromRef(String(payload.ref ?? ""));
  } catch (error) {
    const reason = error instanceof WebhookError ? error.message : "Unsupported ref";
    await markDelivery(deliveryId, "ignored", {
      error: reason,
      repository: fullName,
      installation: installationId ?? undefined,
    });
    return { status: "ignored", reason: "unsupported_ref" };
  }

  const after = String(payload.after ?? "").toLowerCase();
  if (payload.deleted === true || /^0{40}$/.test(after)) {
    await markDelivery(deliveryId, "ignored", {
      error: "Branch deleted",
      repository: fullName,
      installation: installationId ?? undefined,
    });
    return { status: "ignored", reason: "branch_deleted" };
  }
  if (!SHA_PATTERN.test(after)) {
    await markDelivery(deliveryId, "failed", {
      error: "Invalid commit SHA",
      repository: fullName,
      installation: installationId ?? undefined,
    });
    throw new WebhookError("INVALID_SHA", "Invalid commit SHA in payload", 400);
  }

  const linked = await findLinkedProjectForBranch(fullName, branch);
  if (!linked) {
    const anyLink = await findLinkedProject(fullName);
    const reason = anyLink ? "branch_mismatch_or_disabled" : "repository_not_linked";
    await markDelivery(deliveryId, "ignored", {
      error: reason,
      repository: fullName,
      installation: installationId ?? undefined,
    });
    return { status: "ignored", reason };
  }
  const project = linked.project;
  if (project.auto_deploy !== true) {
    await markDelivery(deliveryId, "ignored", {
      error: "auto_deploy disabled",
      repository: fullName,
      installation: installationId ?? undefined,
    });
    return { status: "ignored", reason: "auto_deploy_disabled" };
  }
  if (
    installationId !== null &&
    linked.repo.installation_id !== null &&
    Number(linked.repo.installation_id) !== installationId
  ) {
    await markDelivery(deliveryId, "ignored", {
      error: "installation mismatch",
      repository: fullName,
      installation: installationId,
    });
    return { status: "ignored", reason: "installation_mismatch" };
  }

  const idempotencyKey = `github:${deliveryId}`;
  try {
    const deployment = await createDeployment({
      projectId: project.id as string,
      trigger: "github_push",
      idempotencyKey,
      commitSha: after,
    });
    if (!deployment) {
      await markDelivery(deliveryId, "failed", {
        error: "Project not found",
        repository: fullName,
        installation: installationId ?? undefined,
      });
      throw new WebhookError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    await markDelivery(deliveryId, "processed", {
      deploymentId: deployment.id,
      repository: fullName,
      installation: installationId ?? undefined,
    });
    return { status: "processed", deploymentId: deployment.id as string };
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    if (error instanceof DeploymentConflictError) {
      await markDelivery(deliveryId, "failed", {
        error: "Project already has an active deployment",
        repository: fullName,
        installation: installationId ?? undefined,
      }).catch(() => undefined);
      throw new WebhookError(
        "DEPLOYMENT_CONFLICT",
        "Project already has an active deployment",
        409
      );
    }
    const message = error instanceof Error ? error.message.slice(0, 500) : "Deployment creation failed";
    await markDelivery(deliveryId, "failed", {
      error: message,
      repository: fullName,
      installation: installationId ?? undefined,
    }).catch(() => undefined);
    throw new WebhookError("DEPLOYMENT_FAILED", "Failed to create deployment", 500);
  }
}
