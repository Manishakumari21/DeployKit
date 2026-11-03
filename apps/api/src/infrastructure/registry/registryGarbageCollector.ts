import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import pool from "../../db/database.js";
import { runCommand, type ExecResult } from "../process/dockerExec.js";
import {
  digestReference,
  getOptionalRegistryConfig,
  validateImageDigest,
  validateRegistryRepository,
  type RegistryConfig,
} from "./registryConfig.js";
import { registryLoginCaPath, resolveRegistryCredentials, type RegistryCredentials } from "./registryAuth.js";

export const DEFAULT_GC_KEEP_RELEASES = 20;
export const MIN_GC_KEEP_RELEASES = 1;
export const MAX_GC_KEEP_RELEASES = 500;

export interface RegistryGcOptions {
  enabled: boolean;
  keepReleases: number;
}

/**
 * Keeps images for the last N non-failed releases per project plus every
 * release that is currently active, no matter how old — anything older is
 * garbage. Rollbacks re-create a release row pointing at an older digest, so
 * protection is keyed on the digest pairs any kept release still references.
 */
export function readRegistryGcOptions(
  env: NodeJS.ProcessEnv = process.env
): RegistryGcOptions {
  const keepRaw = env.DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES?.trim();
  let keepReleases = DEFAULT_GC_KEEP_RELEASES;
  if (keepRaw !== undefined && keepRaw !== "") {
    const parsed = Number(keepRaw);
    if (Number.isFinite(parsed)) {
      keepReleases = Math.min(
        MAX_GC_KEEP_RELEASES,
        Math.max(MIN_GC_KEEP_RELEASES, Math.floor(parsed))
      );
    }
  }

  // An unreadable enable flag fails closed: never mutate the registry when
  // the operator's intent is ambiguous.
  const rawEnabled = env.DEPLOYKIT_REGISTRY_GC_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled === undefined || rawEnabled === ""
    ? true
    : rawEnabled === "true" || rawEnabled === "1";

  return { enabled, keepReleases };
}

export interface RegistryImageRow {
  projectId: string;
  repository: string;
  digest: string;
  status: string;
  createdAt: string;
}

export interface RegistryGcCandidate {
  repository: string;
  digest: string;
}

export function selectPrunableRegistryImages(
  rows: Array<{
    project_id: string;
    image_repository: string | null;
    image_digest: string | null;
    status: string;
    created_at: string | Date;
  }>,
  keepReleases: number = DEFAULT_GC_KEEP_RELEASES
): RegistryGcCandidate[] {
  const kept = new Set<string>();
  const candidates = new Set<string>();
  const rollbackable = new Map<string, typeof rows>();

  for (const row of rows) {
    const repository = (row.image_repository ?? "").trim();
    if (!repository || row.status === "failed") continue;
    let digest: string;
    try {
      digest = validateImageDigest(row.image_digest ?? "");
    } catch {
      continue;
    }
    if (!digest) continue;

    const key = digestReference(repository, digest);
    candidates.add(key);
    if (row.status === "active") {
      kept.add(key);
      continue;
    }

    const project = row.project_id;
    const list = rollbackable.get(project);
    if (list) {
      list.push(row);
    } else {
      rollbackable.set(project, [row]);
    }
  }

  for (const list of rollbackable.values()) {
    list.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    for (const row of list.slice(0, keepReleases)) {
      kept.add(digestReference(row.image_repository!, row.image_digest!));
    }
  }

  return [...candidates]
    .filter((key) => !kept.has(key))
    .map((key) => {
      const index = key.indexOf("@");
      return { repository: key.slice(0, index), digest: key.slice(index + 1) };
    });
}

/** The repository path as the Registry v2 API expects it (host stripped). */
export function manifestPathFromRepository(
  repository: string,
  registry?: RegistryConfig | null
): string | null {
  let value: string;
  try {
    value = validateRegistryRepository(repository);
  } catch {
    return null;
  }
  if (registry && !value.startsWith(`${registry.registryHost}/`)) {
    return null;
  }
  const parts = value.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : null;
}

export interface RegistryGcDb {
  query(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

export async function loadRegistryImageRows(
  db: RegistryGcDb = pool
): Promise<Array<{
  project_id: string;
  image_repository: string | null;
  image_digest: string | null;
  status: string;
  created_at: string;
}>> {
  const result = await db.query(
    `SELECT project_id::text, image_repository, image_digest,
            status::text AS status, created_at
     FROM releases`
  );
  return result.rows.map((row) => ({
    project_id: String(row.project_id),
    image_repository: (row.image_repository as string | null) ?? null,
    image_digest: (row.image_digest as string | null) ?? null,
    status: String(row.status),
    created_at: new Date(row.created_at as string).toISOString(),
  }));
}

const MANIFEST_ACCEPT_HEADER = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface RegistryRequestOptions {
  protocol: "https:" | "http:";
  host: string;
  port: string;
  path: string;
  headers: Record<string, string>;
  caPem?: string;
  timeoutMs: number;
}

export type RegistryRequestTransport = (
  options: RegistryRequestOptions
) => Promise<{ status: number; body: string }>;

const DEFAULT_DELETE_TIMEOUT_MS = 15_000;

export function buildRegistryManifestDeleteRequest(input: {
  registryHost: string;
  repositoryPath: string;
  digest: string;
  insecure?: boolean;
  caPem?: string | null;
  credentials?: RegistryCredentials | null;
  timeoutMs?: number;
}): RegistryRequestOptions {
  const hostname = input.registryHost.split(":")[0];
  const insecure = input.insecure === true;
  const explicitPort = insecure
    ? input.registryHost.split(":")[1]
    : undefined;
  const port = explicitPort ?? (insecure ? "80" : "443");
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT_HEADER };
  if (input.credentials) {
    const token = Buffer.from(
      `${input.credentials.username}:${input.credentials.password}`
    ).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  return {
    protocol: insecure ? "http:" : "https:",
    host: hostname,
    port,
    path: `/v2/${input.repositoryPath}/manifests/${input.digest}`,
    headers,
    ...(input.caPem && !insecure ? { caPem: input.caPem } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS,
  };
}

export function defaultRegistryRequestTransport(
  options: RegistryRequestOptions
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const doRequest = options.protocol === "https:" ? httpsRequest : httpRequest;
    const request = doRequest(
      {
        protocol: options.protocol,
        host: options.host,
        port: Number(options.port),
        method: "DELETE",
        path: options.path,
        headers: options.headers,
        ...(options.protocol === "https:" && options.caPem
          ? { ca: [options.caPem], rejectUnauthorized: true }
          : {}),
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      }
    );
    const timer = setTimeout(() => {
      request.destroy(new Error("registry request timed out"));
    }, options.timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    request.end();
  });
}

export type ManifestDeleteOutcome =
  | "deleted"
  | "missing"
  | "deletion-disabled"
  | "unauthorized"
  | "error";

export function classifyManifestDeleteStatus(status: number): ManifestDeleteOutcome {
  if (status >= 200 && status < 300) return "deleted";
  if (status === 404) return "missing";
  if (status === 405) return "deletion-disabled";
  if (status === 401 || status === 403) return "unauthorized";
  return "error";
}

export function registryGarbageCollectArgs(
  registryContainer: string,
  configPath: string
): string[] {
  return ["exec", registryContainer, "registry", "garbage-collect", configPath];
}

export interface RunRegistryGcOptions {
  dockerBinary?: string;
  registryContainer?: string;
  configPath?: string;
  timeoutMs?: number;
}

/** Online GC: distribution tolerates it; blobs re-pushed mid-scan are safe. */
export async function runRegistryGarbageCollect(
  options: RunRegistryGcOptions = {}
): Promise<ExecResult> {
  const dockerBinary =
    options.dockerBinary ?? process.env.DEPLOYKIT_DOCKER_BINARY ?? "docker";
  const registryContainer =
    options.registryContainer ??
    process.env.DEPLOYKIT_REGISTRY_CONTAINER ??
    "deploykit-registry";
  const configPath =
    options.configPath ??
    process.env.DEPLOYKIT_REGISTRY_CONFIG_PATH ??
    "/etc/docker/registry/config.yml";
  const timeoutMs = options.timeoutMs ?? 300_000;

  return await runCommand(
    dockerBinary,
    registryGarbageCollectArgs(registryContainer, configPath),
    timeoutMs
  );
}

export interface RegistryGcSummary {
  candidates: number;
  deleted: number;
  missing: number;
  deletionDisabled: boolean;
  unauthorized: boolean;
  errors: number;
  errorSamples: string[];
  gcRun: boolean;
}

export interface PruneRegistryOptions {
  db?: RegistryGcDb;
  keepReleases?: number;
  registry?: RegistryConfig | null;
  transport?: RegistryRequestTransport;
  runGc?: typeof runRegistryGarbageCollect;
  certsDir?: string;
}

/**
 * Deletes manifests for prunable releases, then runs distribution GC so the
 * orphaned blobs are reclaimed. Never throws into the caller: registry-side
 * failures are counted in the summary so a deploy never fails because of GC.
 */
export async function pruneRegistryImages(
  options: PruneRegistryOptions = {}
): Promise<RegistryGcSummary | null> {
  const gcOptions = readRegistryGcOptions();
  if (!gcOptions.enabled) return null;

  let registry = options.registry;
  if (registry === undefined) {
    try {
      registry = getOptionalRegistryConfig();
    } catch {
      registry = null;
    }
  }
  if (!registry) return null;

  const db = options.db ?? pool;
  const rows = await loadRegistryImageRows(db);
  const prunable = selectPrunableRegistryImages(
    rows,
    options.keepReleases ?? gcOptions.keepReleases
  );

  const certsDir = options.certsDir ?? process.env.DEPLOYKIT_CERTS_DIR ?? "/certs";
  const credentials = resolveRegistryCredentials();
  const transport = options.transport ?? defaultRegistryRequestTransport;
  const runGc = options.runGc ?? runRegistryGarbageCollect;

  const summary: RegistryGcSummary = {
    candidates: prunable.length,
    deleted: 0,
    missing: 0,
    deletionDisabled: false,
    unauthorized: false,
    errors: 0,
    errorSamples: [],
    gcRun: false,
  };

  for (const { repository, digest } of prunable) {
    if (!repository.startsWith(`${registry.registryHost}/`)) continue;
    const repositoryPath = manifestPathFromRepository(repository, registry);
    if (!repositoryPath) {
      summary.errors += 1;
      summary.errorSamples.push(`unsupported repository ${repository.slice(0, 200)}`);
      continue;
    }

    let caPem: string | null = null;
    if (!registry.insecure) {
      const caPath = registryLoginCaPath(registry.registryHost, certsDir);
      if (caPath && existsSync(caPath)) {
        caPem = readFileSync(caPath, "utf8");
      }
    }

    try {
      const response = await transport(
        buildRegistryManifestDeleteRequest({
          registryHost: registry.registryHost,
          repositoryPath,
          digest,
          insecure: registry.insecure,
          caPem,
          credentials,
        })
      );
      const outcome = classifyManifestDeleteStatus(response.status);
      if (outcome === "deleted") summary.deleted += 1;
      else if (outcome === "missing") summary.missing += 1;
      else if (outcome === "deletion-disabled") summary.deletionDisabled = true;
      else if (outcome === "unauthorized") summary.unauthorized = true;
      else summary.errors += 1;
    } catch (error) {
      summary.errors += 1;
      summary.errorSamples.push(
        `delete ${repositoryPath}@${digest.slice(0, 19)}: ${
          error instanceof Error ? error.message.slice(0, 160) : "unknown error"
        }`
      );
    }
  }
  summary.errorSamples = summary.errorSamples.slice(0, 3);

  // 404s still mean an earlier deletion left orphaned blobs, so GC runs in
  // either case; a stopped delete endpoint or auth failure must not flag it.
  if (summary.deleted + summary.missing > 0) {
    const gc = await runGc().catch(
      () => ({ code: 1, stderr: "registry garbage-collect unavailable" } as ExecResult)
    );
    summary.gcRun = gc.code === 0;
    if (!summary.gcRun) {
      summary.errors += 1;
      summary.errorSamples.push(`garbage-collect failed: ${gc.stderr.slice(0, 160)}`);
    }
  }

  return summary;
}
