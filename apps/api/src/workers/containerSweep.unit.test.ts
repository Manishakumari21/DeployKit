import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import {
  parseManagedContainerName,
  parseDockerLsLine,
  classifyContainer,
  checkCandidateActiveOrInFlight,
  sweepUnactivatedContainers,
  type DiscoveredContainer,
} from "./containerSweep.js";
import { getInstallationId } from "../infrastructure/runtime/installationIdentity.js";
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
  const line = `dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid123\t${getInstallationId()}`;
  const parsed = parseDockerLsLine(line, now);
  assert.ok(parsed);
  assert.equal(parsed.name, "dk-p11111111-d22222222");
  assert.equal(parsed.state, "running");
  assert.equal(parsed.id, "cid123");
  assert.equal(parsed.installationId, getInstallationId());
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
    installationId: getInstallationId(),
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
    installationId: getInstallationId(),
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
    installationId: getInstallationId(),
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
    installationId: "other-installation-uuid",
    projectPrefix: "99999999",
    deploymentPrefix: "88888888",
  };

  const mockClient = {
    query: async () => ({ rows: [] }),
  } as any;

  const decision = await classifyContainer(foreignContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "mismatched_installation_id");
});

test("classifyContainer: foreign installation with matching installation ID but absent database records is protected", async () => {
  const now = Date.now();
  const foreignContainer: DiscoveredContainer = {
    name: "dk-p99999999-d88888888",
    state: "running",
    createdAtMs: now - 600_000,
    id: "cid-foreign-matching-inst",
    installationId: getInstallationId(),
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
    installationId: getInstallationId(),
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
  const dockerLsOutput = `dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid-race\t${getInstallationId()}\n`;

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
    `dk-p11111111-d22222221\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-1\t${getInstallationId()}`,
    `dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-2\t${getInstallationId()}`,
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
  const dockerLsOutput = `dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-1\t${getInstallationId()}\n`;

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

test("classifyContainer: ambiguous project prefix is protected", async () => {
  const now = Date.now();
  const container: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 600_000,
    id: "cid-ambig-proj",
    installationId: getInstallationId(),
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes("FROM projects")) {
        // Two projects match prefix!
        return {
          rows: [
            { id: "11111111-0000-0000-0000-000000000001" },
            { id: "11111111-0000-0000-0000-000000000002" },
          ],
        };
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(container, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "ambiguous_project_prefix");
});

test("classifyContainer: ambiguous deployment prefix is protected", async () => {
  const now = Date.now();
  const container: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 600_000,
    id: "cid-ambig-dep",
    installationId: getInstallationId(),
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async (sql: string) => {
      if (sql.includes("FROM projects")) {
        return { rows: [{ id: "11111111-0000-0000-0000-000000000000" }] };
      }
      if (sql.includes("FROM deployments")) {
        // Two deployments match prefix!
        return {
          rows: [
            {
              id: "22222222-0000-0000-0000-000000000001",
              project_id: "11111111-0000-0000-0000-000000000000",
              status: "failed",
              release_id: null,
              job_status: null,
              lease_expires_at: null,
            },
            {
              id: "22222222-0000-0000-0000-000000000002",
              project_id: "11111111-0000-0000-0000-000000000000",
              status: "failed",
              release_id: null,
              job_status: null,
              lease_expires_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(container, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "ambiguous_deployment_prefix");
});

test("classifyContainer: mismatched project/deployment ownership is protected", async () => {
  const now = Date.now();
  const container: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "running",
    createdAtMs: now - 600_000,
    id: "cid-mismatch",
    installationId: getInstallationId(),
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
              project_id: "99999999-0000-0000-0000-000000000000", // Mismatched project ID!
              status: "failed",
              release_id: null,
              job_status: null,
              lease_expires_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(container, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "mismatched_ownership");
});

test("classifyContainer: cancelled deployment cleanup", async () => {
  const now = Date.now();
  const container: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "exited",
    createdAtMs: now - 600_000,
    id: "cid-cancelled",
    installationId: getInstallationId(),
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
              status: "cancelled", // Cancelled deployment!
              release_id: null,
              job_status: null,
              lease_expires_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM runtime_instances")) return { rows: [] };
      return { rows: [] };
    },
  } as any;

  const decision = await classifyContainer(container, mockClient, now, 300_000);
  assert.equal(decision.action, "sweep");
  assert.equal(decision.reason, "deployment_cancelled");
});

test("sweepUnactivatedContainers: batch limit enforcement stops sweep after limit", async () => {
  const now = Date.now();
  const dockerLsOutput = [
    `dk-p11111111-d22222221\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-1\t${getInstallationId()}`,
    `dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-2\t${getInstallationId()}`,
    `dk-p11111111-d22222223\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-3\t${getInstallationId()}`,
    `dk-p11111111-d22222224\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-4\t${getInstallationId()}`,
  ].join("\n");

  let rmCalls = 0;
  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "rm") {
      rmCalls++;
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
    options: { batchLimit: 2 },
  });

  assert.equal(summary.inspected, 4);
  assert.equal(summary.swept, 2, "Only batchLimit (2) candidates should be swept");
  assert.equal(summary.skipped, 2, "Remaining candidates should be skipped");
  assert.equal(summary.reasons["batch_limit_reached"], 2);
  assert.equal(rmCalls, 2);
});

test("sweepUnactivatedContainers: Docker command timeout increments errors and prevents DB updates", async () => {
  const now = Date.now();
  const dockerLsOutput = `dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-timeout\t${getInstallationId()}\n`;

  let dbUpdateCalled = false;
  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "rm") {
      return { code: 1, stdout: "", stderr: "Docker rm timed out", timedOut: true, aborted: false };
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
        if (sql.includes("UPDATE runtime_instances")) {
          dbUpdateCalled = true;
          return { rowCount: 1 };
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
  assert.equal(summary.errors, 1);
  assert.equal(dbUpdateCalled, false, "Database must NOT be updated after Docker command timeout");
});

test("parseDockerLsLine: invalid and non-managed container names are strictly rejected", () => {
  const now = 1700000000000;
  const invalidLines = [
    "dk-gateway\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid1",
    "dk-agent-12345678\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid2",
    "some-random-container\texited\t2026-11-22 10:00:00 +0000 UTC\tcid3",
    "dk-pZZZZZZZZ-d12345678\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid4",
    "dk-p12345-d67890\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid5",
    "",
    "   ",
  ];

  for (const line of invalidLines) {
    const res = parseDockerLsLine(line, now);
    assert.equal(res, null, `Line "${line}" should return null`);
  }
});

// =========================================================================
// REGRESSION TESTS: Deployment/Cleanup Coordination, Installation Identity,
// State Transitions, and Atomic DB Updates
// =========================================================================

test("sweepUnactivatedContainers: release activation racing with cleanup aborts when session advisory lock cannot be acquired", async () => {
  const now = Date.now();
  const dockerLsOutput = `dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid-rel-race\t${getInstallationId()}\n`;

  let rmCalled = false;
  let stopCalled = false;
  let lockCallCount = 0;
  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "stop") {
      stopCalled = true;
      return mockExecOk();
    }
    if (args[0] === "container" && args[1] === "rm") {
      rmCalled = true;
      return mockExecOk();
    }
    return mockExecOk();
  };

  const mockPool = {
    connect: async () => ({
      query: async (sql: string, params: any[]) => {
        if (sql.includes("pg_try_advisory_lock")) {
          // First lock is worker lock (CONTAINER_SWEEP), second is project coordination lock (PROJECT_ACTIVE_RELEASE)
          lockCallCount++;
          if (lockCallCount === 1) {
            return { rows: [{ acquired: true }] };
          }
          // Project coordination lock FAILS because activateRelease is running and holds it!
          return { rows: [{ acquired: false }] };
        }
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
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reasons["race_abort_active"], 1);
  assert.equal(stopCalled, false, "Stop must NOT be called when project lock is held by activateRelease");
  assert.equal(rmCalled, false, "Rm must NOT be called when project lock is held by activateRelease");
});

test("sweepUnactivatedContainers: state transition during docker stop aborts before docker rm", async () => {
  const now = Date.now();
  const dockerLsOutput = `dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid-stop-race\t${getInstallationId()}\n`;

  let stopCalls = 0;
  let rmCalls = 0;
  let checkCount = 0;

  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "stop") {
      stopCalls++;
      return mockExecOk();
    }
    if (args[0] === "container" && args[1] === "rm") {
      rmCalls++;
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
          checkCount++;
          // First check (pre-stop): not active
          if (checkCount === 1) return { rows: [{ count: "0" }] };
          if (checkCount === 2) return { rows: [{ count: "0" }] };
          // Second check (post-stop, pre-rm): deployment became active during stop!
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
  assert.equal(stopCalls, 1, "Container was stopped during sweep");
  assert.equal(rmCalls, 0, "Container removal must be aborted when post-stop check detects active transition");
});

test("classifyContainer: foreign installation with coincidentally matching project/deployment prefixes is protected by label", async () => {
  const now = Date.now();
  const foreignCoincidentContainer: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "exited",
    createdAtMs: now - 600_000,
    id: "cid-foreign-coincident",
    installationId: "foreign-cluster-9999",
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async () => ({
      rows: [{ id: "11111111-0000-0000-0000-000000000000" }],
    }),
  } as any;

  const decision = await classifyContainer(foreignCoincidentContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "mismatched_installation_id");
});

test("classifyContainer: container missing installation label is protected", async () => {
  const now = Date.now();
  const missingLabelContainer: DiscoveredContainer = {
    name: "dk-p11111111-d22222222",
    state: "exited",
    createdAtMs: now - 600_000,
    id: "cid-no-label",
    installationId: undefined, // No label present
    projectPrefix: "11111111",
    deploymentPrefix: "22222222",
  };

  const mockClient = {
    query: async () => ({ rows: [] }),
  } as any;

  const decision = await classifyContainer(missingLabelContainer, mockClient, now, 300_000);
  assert.equal(decision.action, "protect");
  assert.equal(decision.reason, "missing_installation_label");
});

test("checkCandidateActiveOrInFlight: verifies exact deployment ID matching in queries", async () => {
  const fullDeploymentId = "22222222-3333-4444-5555-666666666666";
  const fullProjectId = "11111111-3333-4444-5555-666666666666";

  const executedQueries: { sql: string; params: any[] }[] = [];
  const mockClient = {
    query: async (sql: string, params: any[]) => {
      executedQueries.push({ sql, params });
      return { rows: [{ count: "0" }] };
    },
  } as any;

  const isActive = await checkCandidateActiveOrInFlight(mockClient, fullProjectId, fullDeploymentId);
  assert.equal(isActive, false);

  assert.ok(executedQueries.length >= 1);
  const depQuery = executedQueries[0];
  assert.ok(depQuery.sql.includes("WHERE d.id = $1"), "Must use exact equality d.id = $1, not prefix matching");
  assert.equal(depQuery.params[0], fullDeploymentId, "Must pass the exact full deployment UUID");
});

test("sweepUnactivatedContainers: database state remains unchanged after failed container stop", async () => {
  const now = Date.now();
  const dockerLsOutput = `dk-p11111111-d22222222\trunning\t2026-11-22 10:00:00 +0000 UTC\tcid-stop-fail\t${getInstallationId()}\n`;

  let dbUpdateAttempted = false;
  let rmAttempted = false;

  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "stop") {
      return mockExecFail(1, "docker container stop failed: permission denied");
    }
    if (args[0] === "container" && args[1] === "rm") {
      rmAttempted = true;
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
        if (sql.includes("COUNT(*)::text AS count")) return { rows: [{ count: "0" }] };
        if (sql.includes("UPDATE") || sql.includes("DELETE") || sql.includes("INSERT")) {
          dbUpdateAttempted = true;
          return { rowCount: 1 };
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
  assert.equal(summary.errors, 1);
  assert.equal(rmAttempted, false, "docker rm must not be called when docker stop fails");
  assert.equal(dbUpdateAttempted, false, "database state must not be modified when docker stop fails");
});

test("sweepUnactivatedContainers: database state remains unchanged after failed container rm", async () => {
  const now = Date.now();
  const dockerLsOutput = `dk-p11111111-d22222222\texited\t2026-11-22 10:00:00 +0000 UTC\tcid-rm-fail\t${getInstallationId()}\n`;

  let dbUpdateAttempted = false;

  const runFn = async (binary: string, args: string[]) => {
    if (args[0] === "container" && args[1] === "ls") return mockExecOk(dockerLsOutput);
    if (args[0] === "container" && args[1] === "rm") {
      return mockExecFail(1, "docker container rm: device or resource busy");
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
        if (sql.includes("UPDATE") || sql.includes("DELETE") || sql.includes("INSERT")) {
          dbUpdateAttempted = true;
          return { rowCount: 1 };
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
  assert.equal(summary.errors, 1);
  assert.equal(dbUpdateAttempted, false, "database state must not be modified when docker rm fails");
});
