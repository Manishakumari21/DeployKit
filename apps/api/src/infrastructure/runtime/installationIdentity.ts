import crypto from "node:crypto";

export const INSTALLATION_ID_LABEL = "io.deploykit.installation-id";

/**
 * Returns the unique identity of this DeployKit installation.
 * Uses DEPLOYKIT_INSTALLATION_ID if set, otherwise falls back to a deterministic
 * 16-character hex digest of DATABASE_URL, ensuring different databases on the same host
 * possess distinct installation identities.
 */
export function getInstallationId(): string {
  const envId = process.env.DEPLOYKIT_INSTALLATION_ID?.trim();
  if (envId) return envId;
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    return crypto.createHash("sha256").update(dbUrl).digest("hex").slice(0, 16);
  }
  return "deploykit-default";
}
