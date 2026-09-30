export type DeploymentStatus =
  | "queued"
  | "cloning"
  | "building"
  | "pushing"
  | "deploying"
  | "verifying"
  | "active"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> =
  new Set(["active", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Record<
  DeploymentStatus,
  ReadonlySet<DeploymentStatus>
> = {
  queued: new Set(["cloning", "cancelled", "queued"]),
  cloning: new Set(["building", "failed", "cancelled", "queued"]),
  building: new Set(["pushing", "verifying", "failed", "cancelled", "queued"]),
  pushing: new Set(["verifying", "failed", "cancelled", "queued"]),
  verifying: new Set(["deploying", "failed", "cancelled", "queued"]),
  deploying: new Set(["active", "failed", "cancelled"]),
  active: new Set([]),
  failed: new Set(["queued"]),
  cancelled: new Set([]),
};

export function canTransition(
  from: DeploymentStatus,
  to: DeploymentStatus
): boolean {
  if (from === to) {
    return from === "queued";
  }
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(
  from: DeploymentStatus,
  to: DeploymentStatus
): void {
  if (!canTransition(from, to)) {
    throw new DeploymentStateError(
      `Invalid deployment transition ${from} -> ${to}`
    );
  }
}

export class DeploymentStateError extends Error {
  readonly code = "INVALID_DEPLOYMENT_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "DeploymentStateError";
  }
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
