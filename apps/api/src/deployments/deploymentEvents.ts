import type { PoolClient } from "pg";
import type { DeploymentStatus } from "./deploymentStateMachine.js";

export async function recordDeploymentEvent(
  client: PoolClient,
  input: {
    deploymentId: string;
    eventType: string;
    statusFrom: DeploymentStatus | null;
    statusTo: DeploymentStatus | null;
    message: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!/^[a-z0-9._-]{1,100}$/i.test(input.eventType)) {
    throw new Error("Invalid deployment event type");
  }
  await client.query(
    `
    INSERT INTO deployment_events (
      deployment_id, event_type, status_from, status_to, message, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      input.deploymentId,
      input.eventType,
      input.statusFrom,
      input.statusTo,
      input.message.slice(0, 4000),
      JSON.stringify(sanitizeMetadata(input.metadata ?? {})),
    ]
  );
}

function sanitizeMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      continue;
    }
    if (
      /token|secret|password|credential|authorization|cookie/i.test(
        key
      )
    ) {
      out[key] = "[redacted]";
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[key] =
        typeof value === "string"
          ? value.slice(0, 2000)
          : value;
    }
  }
  return out;
}
