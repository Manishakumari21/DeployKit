import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import {
  parseManagedContainerName,
  parseDockerLsLine,
  classifyContainer,
  sweepUnactivatedContainers,
  type DiscoveredContainer,
} from "./containerSweep.js";
import type { ExecResult } from "../infrastructure/process/dockerExec.js";

function mockExecOk(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr, timedOut: false, aborted: false };
}

function mockExecFail(code = 1, stderr = "command failed"): ExecResult {
  return { code, stdout: "", stderr, timedOut: false, aborted: false };
}

test("parseManagedContainerName validates format and extracts prefixes", () => {
  assert.deepEqual(parseManagedContainerName("dk-p12345678-dabcdef12"), {
    valid: true,
    projectPrefix: "12345678",
    deploymentPrefix: "abcdef12",
  });
  assert.equal(parseManagedContainerName("dk-gateway").valid, false);
  assert.equal(parseManagedContainerName("deploykit-worker").valid, false);
  assert.equal(parseManagedContainerName("dk-pZZZZZZZZ-d12345678").valid, false);
  assert.equal(parseManagedContainerName("").valid, false);
});

test("parseDockerLsLine correctly parses Docker format and cleans timestamps", () => {
  const now = 1700000000000;
  const line = "dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid123";
  const parsed = parseDockerLsLine(line, now);
  assert.ok(parsed);
  assert.equal(parsed.name, "dk-p11111111-d22222222");
  assert.equal(parsed.state, "running");
  assert.equal(parsed.id, "cid123");
  assert.equal(parsed.projectPrefix, "11111111");
  assert.equal(parsed.deploymentPrefix, "22222222");
  assert.ok(parsed.createdAtMs > 0);
});

test("classifyContainer: active release protection regardless of age", async () => {
  const now = Date.now();
  const oldContainer: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 30 * 24 * 60 * 60 * 1000, // 30 days old
    id: "cid-1",
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
      }
      if (sql.includes("FROM deployments")) {
        return {
          rows: [
            {
              id: "22222222-0000-0000-0000-000000000000",
              project_id: "11111111-0000-0000-0000-000000000000",
              status: "active",
              release_id: "33333333-0000-0000-0000-000000000000",
              job_status: null,
              lease_expires_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM runtime_instances")) {
        return {
          rows: [
            {
              id: "inst-1",
              release_id: "33333333-0000-0000-0000-000000000000",
              status: "running",
              rel_status: "active",
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(oldContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "active_release");
});

test("classifyContainer: active lease protection regardless of age", async () => {
  const now = Date.now();
  const container: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 600_000, // 10 minutes old
    id: "cid-2",
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
      }
      if (sql.includes("FROM deployments")) {
        return {
          rows: [
            {
              id: "22222222-0000-0000-0000-000000000000",
              project_id: "11111111-0000-0000-0000-000000000000",
              status: "deploying",
              release_id: null,
              job_status: "running",
              lease_expires_at: new Date(now + 60_000), // active lease!
            },
          ],
        };
      }
      if (sql.includes("FROM runtime_instances")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(container, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "active_job_lease");
});

test("classifyContainer: grace period protection (< minAgeMs)", async () => {
  const now = Date.now();
  const youngContainer: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 10_000, // only 10s old
    id: "cid-young",
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = { query: async () => ({ rows: [] }) } as any;
  const decision = await classifyContainer(youngContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "in_grace_period");
});

test("classifyContainer: containers belonging to another DeployKit installation are protected", async () => {
  const now = Date.now();
  const foreignContainer: DiscoveredContainer = {
    name: "dk-p99999999-d88888888",
    state: "running",
    createdAtMs: now - 600_000,
    id: "cid-foreign",
    projectPrefix: "99999999",
    deploymentPrefix: "88888888",
  };

  const mockClient = {
    query: async () => ({ rows: [] }), // Not found in this DB
  } as any;

  const decision = await classifyContainer(foreignContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "foreign_installation");
});

test("classifyContainer: Docker create-before-DB-insert crash recovery (missing runtime_instances)", async () => {
  const now = Date.now();
  const crashContainer: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "exited",
    createdAtMs: now - 600_000,
    id: "cid-crash",
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
      }
      if (sql.includes("FROM deployments")) {
        return {
          rows: [
            {
              id: "22222222-0000-0000-0000-000000000000",
              project_id: "11111111-0000-0000-0000-000000000000",
              status: "failed", // deployment failed
              release_id: null,
              job_status: null,
              lease_expires_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM runtime_instances")) {
        return { rows: [] }; // No record in runtime_instances!
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(crashContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "sweep");
  assert.equal(decision.reason, "unactivated_crash_orphan");
});

test("sweepUnactivatedContainers: deployment transitioning to active aborts deletion", async () => {
  const now = Date.now();
  const dockerLsOutput = "dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid-race\n";

  let removed = 0;
  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") {
      return mockExecOk(dockerLsOutput);
    }
    if (args[0] === "container" && args[1] === "rm") {
      removed++;
      return mockExecOk();
    }
    return mockExecOk();
  };

  const mockPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
        if (sql.includes("FROM projects")) return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
        if (sql.includes("FROM deployments d") && !sql.includes("COUNT(*)")) {
          return {
            rows: [
              {
                id: "22222222-0000-0000-0000-000000000000",
                project_id: "11111111-0000-0000-0000-000000000000",
                status: "failed",
                release_id: null,
                job_status: null,
                lease_expires_at: null,
              },
            ],
          };
        }
        if (sql.includes("FROM runtime_instances")) return { rows: [] };
        if (sql.includes("COUNT(*)::text AS count")) {
          // Pre-deletion check detects deployment transitioned to active right now!
          return { rows: [{ count: "1" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  } as any;

  const summary = await sweepUnactivatedContainers({
    pool: mockPool,
    runFn: runFn as any,
    now: () => now + 600_000,
  });

  assert.equal(summary.swept, 0);
  assert.equal(summary.reasons["race_abort_active"], 1);
  assert.equal(removed, 0, "Container rm must NOT be called when race abort triggers");
});

test("sweepUnactivatedContainers: partial Docker failures do not abort remaining candidates", async () => {
  const now = Date.now();
  const dockerLsOutput = [
    "dk-p11111111-d22222221\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-1",
    "dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-2",
  ].join("\n");

  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "rm") {
      const target = args[3];
      if (target === "dk-p11111111-d22222221") {
        return mockExecFail(1, "docker command timed out");
      }
      return mockExecOk();
    }
    return mockExecOk();
  };

  const mockPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
        if (sql.includes("FROM projects")) return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
        if (sql.includes("FROM deployments d") && !sql.includes("COUNT(*)")) {
          return {
            rows: [
              {
                id: "22222221-0000-0000-0000-000000000000",
                project_id: "11111111-0000-0000-0000-000000000000",
                status: "failed",
                release_id: null,
                job_status: null,
                lease_expires_at: null,
              },
            ],
          };
        }
        if (sql.includes("FROM runtime_instances")) return { rows: [] };
        if (sql.includes("COUNT(*)::text AS count")) return { rows: [{ count: "0" }] };
        return { rows: [] };
      },
      release: () => {},
    }),
  } as any;

  const summary = await sweepUnactivatedContainers({
    pool: mockPool,
    runFn: runFn as any,
    now: () => now + 600_000,
  });

  assert.equal(summary.inspected, 2);
  assert.equal(summary.errors, 1, "First container removal timed out");
  assert.equal(summary.swept, 1, "Second container removal succeeded despite first error");
});

test("sweepUnactivatedContainers: advisory lock mutual exclusion skips when locked", async () => {
  const mockPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }] };
        return { rows: [] };
      },
      release: () => {},
    }),
  } as any;

  const summary = await sweepUnactivatedContainers({ pool: mockPool });
  assert.equal(summary.locked, true);
  assert.equal(summary.swept, 0);
  assert.equal(summary.inspected, 0);
});

test("sweepUnactivatedContainers: repeated sweeps on already-removed containers are idempotent", async () => {
  const now = Date.now();
  const dockerLsOutput = "dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-1\n";

  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "rm") {
      // Simulates container already removed concurrently
      return mockExecFail(1, "Error response from daemon: No such container: dk-p11111111-d22222222");
    }
    return mockExecOk();
  };

  const mockPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
        if (sql.includes("FROM projects")) return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
        if (sql.includes("FROM deployments d") && !sql.includes("COUNT(*)")) {
          return {
            rows: [
              {
                id: "22222222-0000-0000-0000-000000000000",
                project_id: "11111111-0000-0000-0000-000000000000",
                status: "failed",
                release_id: null,
                job_status: null,
                lease_expires_at: null,
              },
            ],
          };
        }
        if (sql.includes("FROM runtime_instances")) return { rows: [] };
        if (sql.includes("COUNT(*)::text AS count")) return { rows: [{ count: "0" }] };
        return { rows: [] };
      },
      release: () => {},
    }),
  } as any;

  const summary = await sweepUnactivatedContainers({
    pool: mockPool,
    runFn: runFn as any,
    now: () => now + 600_000,
  });

  assert.equal(summary.swept, 1, "Already-removed container should be marked swept without error");
  assert.equal(summary.errors, 0);
});
