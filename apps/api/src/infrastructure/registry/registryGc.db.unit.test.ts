import test from "node:test";
import assert from "node:assert/strict";

import pool from "../../db/database.js";
import {
  loadRegistryImageRows,
  manifestPathFromRepository,
  pruneRegistryImages,
  selectPrunableRegistryImages,
  type RegistryRequestTransport,
} from "./registryGarbageCollector.js";
import type { RegistryConfig } from "./registryConfig.js";
import { gateDb } from "../../test/dbGate.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(`SELECT to_regclass('public.releases') AS c`);
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

const REGISTRY_HOST = "gc-test-reg.example.com";
const REGISTRY: RegistryConfig = {
  registryHost: REGISTRY_HOST,
  namespace: "gc-test",
  insecure: false,
};

function repoFor(projectId: string): string {
  return `${REGISTRY_HOST}/gc-test/project-${projectId.replace(/-/g, "").slice(0, 8)}`;
}

function sha256(seed: string): string {
  let out = "";
  for (const char of seed) {
    out += char.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return `sha256:${out.padEnd(64, "0").slice(0, 64)}`;
}

async function makeProject(tag: string): Promise<string> {
  const name = `gc-${tag}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch)
     VALUES ($1, $2, 'main')
     RETURNING id`,
    [name, `https://github.com/gc-e2e/${name}`]
  );
  return result.rows[0].id as string;
}

/** created_at is staggered by index so release ordering is deterministic. */
async function makeRelease(input: {
  projectId: string;
  index: number;
  status: string;
  digest: string;
  repository?: string;
}): Promise<void> {
  const deployment = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch)
     VALUES ($1, 'deploying', 'manual', 'main')
     RETURNING id`,
    [input.projectId]
  );
  await pool.query(
    `INSERT INTO releases
       (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'main', $6::release_status, NOW() - ($7 || ' days')::interval)`,
    [
      (deployment.rows[0] as { id: string }).id,
      input.projectId,
      input.repository ?? repoFor(input.projectId),
      input.digest,
      String(input.index).padStart(40, "f"),
      input.status,
      String(input.index),
    ]
  );
}

async function cleanupProjects(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [ids]);
}

interface RecordedDelete {
  transport: RegistryRequestTransport;
  paths: string[];
  statuses: number[];
}

function recordingTransport(
  respond?: Record<string, number>
): RecordedDelete {
  const recorded: RecordedDelete = {
    transport: async (options) => {
      const digest = options.path.split("/manifests/")[1] ?? "";
      recorded.paths.push(options.path);
      const status = respond?.[digest] ?? 202;
      recorded.statuses.push(status);
      return { status, body: "" };
    },
    paths: [],
    statuses: [],
  };
  return recorded;
}

const gcCleanRun = async () => ({
  stdout: "",
  stderr: "",
  code: 0,
  timedOut: false,
  aborted: false,
});

test("pruneRegistryImages deletes only prunable manifests and runs GC once", async () => {
  if (!(await gateDb("infrastructure/registry/registryGc.db.unit.test.ts", dbAvailable))) return;
  const projectIds: string[] = [];
  const { selectPrunableRegistryImages } = await import(
    "./registryGarbageCollector.js"
  );
  // The suite shares a database, so the baseline prune set is measured before
  // the fixtures exist and must remain untouched by this test.
  const baselineBefore = selectPrunableRegistryImages(
    await loadRegistryImageRows(pool),
    3
  )
    .filter((c) => c.repository.startsWith(`${REGISTRY_HOST}/`))
    .map((c) => `/v2/${manifestPathFromRepository(c.repository)}/manifests/${c.digest}`);
  try {
    const projectId = await makeProject("one");
    projectIds.push(projectId);

    await makeRelease({ projectId, index: 1, status: "active", digest: sha256("ancient-active") });
    await makeRelease({ projectId, index: 2, status: "stopped", digest: sha256("a") });
    await makeRelease({ projectId, index: 3, status: "stopped", digest: sha256("b") });
    await makeRelease({ projectId, index: 4, status: "stopped", digest: sha256("c") });
    await makeRelease({ projectId, index: 5, status: "stopped", digest: sha256("d") });
    await makeRelease({ projectId, index: 6, status: "stopped", digest: sha256("e") });
    await makeRelease({ projectId, index: 7, status: "failed", digest: sha256("failed-digest") });

    const deletes = recordingTransport();
    const summary = await pruneRegistryImages({
      db: pool,
      keepReleases: 3,
      registry: REGISTRY,
      transport: deletes.transport,
      runGc: gcCleanRun,
    });

    assert.ok(summary);
    assert.equal(summary.errors, 0);
    assert.equal(summary.deletionDisabled, false);
    assert.equal(summary.unauthorized, false);
    assert.equal(summary.gcRun, true);

    // Exactly the two oldest stopped releases fall outside the 3-release
    // active+window keep set; failed digests are not candidates at all.
    const repositoryPath = manifestPathFromRepository(repoFor(projectId), REGISTRY);
    assert.ok(repositoryPath);
    assert.deepEqual(
      [...deletes.paths].sort(),
      [
        ...baselineBefore,
        `/v2/${repositoryPath}/manifests/${sha256("d")}`,
        `/v2/${repositoryPath}/manifests/${sha256("e")}`,
      ].sort()
    );
  } finally {
    await cleanupProjects(projectIds);
  }
});

test("pruneRegistryImages honours 405 deletion-disabled and skips GC", async () => {
  if (!(await gateDb("infrastructure/registry/registryGc.db.unit.test.ts", dbAvailable))) return;
  const projectIds: string[] = [];
  try {
    const projectId = await makeProject("disabled");
    projectIds.push(projectId);
    await makeRelease({ projectId, index: 1, status: "stopped", digest: sha256("new") });
    await makeRelease({ projectId, index: 4, status: "stopped", digest: sha256("old") });

    const deletes = recordingTransport({ [sha256("old")]: 405 });
    let gcRuns = 0;
    const summary = await pruneRegistryImages({
      db: pool,
      keepReleases: 1,
      registry: REGISTRY,
      transport: deletes.transport,
      runGc: async () => {
        gcRuns += 1;
        return gcCleanRun();
      },
    });

    assert.ok(summary);
    assert.equal(summary.deletionDisabled, true);
    assert.equal(deletes.statuses.every((s) => s === 405), true);
    assert.equal(gcRuns, 0, "GC must not run when nothing was deleted");
  } finally {
    await cleanupProjects(projectIds);
  }
});

test("pruneRegistryImages respects the enabled flag", async () => {
  if (!(await gateDb("infrastructure/registry/registryGc.db.unit.test.ts", dbAvailable))) return;
  const previous = process.env.DEPLOYKIT_REGISTRY_GC_ENABLED;
  try {
    process.env.DEPLOYKIT_REGISTRY_GC_ENABLED = "false";
    const summary = await pruneRegistryImages({ db: pool, registry: REGISTRY });
    assert.equal(summary, null);
  } finally {
    if (previous === undefined) {
      delete process.env.DEPLOYKIT_REGISTRY_GC_ENABLED;
    } else {
      process.env.DEPLOYKIT_REGISTRY_GC_ENABLED = previous;
    }
  }
});

test("pruneRegistryImages returns null when no registry is configured", async () => {
  if (!(await gateDb("infrastructure/registry/registryGc.db.unit.test.ts", dbAvailable))) return;
  const deletes = recordingTransport();
  const summary = await pruneRegistryImages({
    db: pool,
    registry: null,
    transport: deletes.transport,
  });
  assert.equal(summary, null);
  assert.equal(deletes.paths.length, 0);
});

test("releases pointing at other registries are never deleted", async () => {
  if (!(await gateDb("infrastructure/registry/registryGc.db.unit.test.ts", dbAvailable))) return;
  const projectIds: string[] = [];
  const { selectPrunableRegistryImages } = await import(
    "./registryGarbageCollector.js"
  );
  const baseline = selectPrunableRegistryImages(
    await loadRegistryImageRows(pool),
    1
  ).length;
  try {
    const projectId = await makeProject("foreign");
    projectIds.push(projectId);
    await makeRelease({
      projectId,
      index: 1,
      status: "stopped",
      digest: sha256("local-new"),
    });
    await makeRelease({
      projectId,
      index: 5,
      status: "stopped",
      digest: sha256("foreign-old"),
      repository: "other-registry.invalid/ns/project-1",
    });

    const deletes = recordingTransport();
    const summary = await pruneRegistryImages({
      db: pool,
      keepReleases: 1,
      registry: REGISTRY,
      transport: deletes.transport,
      runGc: gcCleanRun,
    });

    assert.ok(summary);
    assert.equal(
      summary.candidates,
      baseline + 1,
      "the foreign release is a candidate"
    );
    assert.equal(deletes.paths.length, 0, "but is never touched");
    assert.equal(summary.deleted, 0);
    assert.equal(summary.gcRun, false);
  } finally {
    await cleanupProjects(projectIds);
  }
});
