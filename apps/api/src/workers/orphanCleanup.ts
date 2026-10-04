import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../infrastructure/process/dockerExec.js";

const CHECKOUT_ROOT =
  process.env.DEPLOYKIT_CHECKOUT_ROOT ??
  path.join(os.tmpdir(), "deploykit-checkouts");

const MANAGED_LABEL = "io.deploykit.managed=true";
// Scoped strictly to DeployKit runtime names: dk-p<8hex>-d<8hex>
const MANAGED_CONTAINER_PATTERN = /^dk-p[0-9a-f]{8}-d[0-9a-f]{8}$/;

export function isManagedOrphanContainer(name: string): boolean {
  return MANAGED_CONTAINER_PATTERN.test(name.trim());
}

export async function cleanupStaleCheckoutWorkspaces(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(CHECKOUT_ROOT);
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("deployment-")) continue;
    const full = path.join(CHECKOUT_ROOT, entry);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      await rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      // Best-effort; startup sweep must never fail bootstrap.
    }
  }
  return removed;
}

export async function cleanupOrphanedContainers(dockerBinary = "docker", timeoutMs = 30_000): Promise<number> {
  // List only DeployKit-owned containers via label; never a global prune.
  // Remove only non-running orphans with DeployKit-scoped names.
  let result;
  try {
    result = await runCommand(
      dockerBinary,
      ["container", "ls", "-a", "--filter", `label=${MANAGED_LABEL}`, "--format", "{{.Names}} {{.State}}"],
      timeoutMs
    );
  } catch {
    return 0;
  }
  if (result.code !== 0) return 0;
  let removed = 0;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, state] = trimmed.split(/\s+/);
    if (!name || !state) continue;
    if (!isManagedOrphanContainer(name)) continue;
    const s = state.toLowerCase();
    // Never touch running/restarting/paused containers (may be active releases).
    if (s === "running" || s === "restarting" || s === "paused") continue;
    try {
      const rmResult = await runCommand(dockerBinary, ["container", "rm", "--force", name], timeoutMs);
      if (rmResult.code === 0) removed++;
    } catch {
      // Best-effort per container.
    }
  }
  return removed;
}
