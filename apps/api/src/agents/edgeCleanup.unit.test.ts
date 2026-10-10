import test from "node:test";
import assert from "node:assert/strict";
import { EdgeApiDefinitiveError } from "./edgeAgentClient.js";
import { EdgeDockerError, edgeContainerName } from "./edgeDocker.js";
import { cleanupOwnedContainers, runEdgeDeploymentOnce, type EdgeCleanupSummary, type EdgeOutcome, } from "./edgeExecutor.js";
import type { ClaimedEdgeJob } from "./edgeJobSchema.js";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4434-8344-444444444444";
const TRUSTED_REPO = "registry.local:5000/deploykit/project-app";
const GOOD_DIGEST = `sha256:${"c".repeat(64)}`;
const OWN_NAME = edgeContainerName(PROJECT_ID, DEPLOYMENT_ID);
const IDENTITY = { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID };
function jobWithTrustedImage(): ClaimedEdgeJob {
    return {
        id: JOB_ID,
        deploymentId: DEPLOYMENT_ID,
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        attempts: 1,
        maxAttempts: 3,
        leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
        branch: "main",
        commitSha: "b".repeat(40),
        image: { repository: TRUSTED_REPO, digest: GOOD_DIGEST, releaseId: "77777777-7777-4777-8777-777777777777" },
    };
}
function runningState() {
    return {
        job: { id: JOB_ID, deploymentId: DEPLOYMENT_ID, status: "running", attempts: 1, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() + 30000).toISOString() },
        deployment: { id: DEPLOYMENT_ID, status: "cloning" },
    };
}
function fakeClient(overrides: {
    claimImpl?: () => unknown;
    heartbeatImpl?: () => unknown;
    completeImpl?: (payload: unknown) => unknown;
    failImpl?: (code: string, message: string) => unknown;
} = {}) {
    const calls: Array<{
        method: string;
        jobId?: string;
        payload?: unknown;
    }> = [];
    const client = {
        claimJob: async () => overrides.claimImpl?.() ?? ({ job: jobWithTrustedImage() }),
        heartbeatJob: async (j: string) => { calls.push({ method: "heartbeat", jobId: j }); return overrides.heartbeatImpl?.() ?? runningState(); },
        completeJob: async (j: string, p: unknown) => { calls.push({ method: "complete", jobId: j, payload: p }); return overrides.completeImpl?.(p) ?? ({ ok: true }); },
        failJob: async (j: string, c: string, m: string) => { calls.push({ method: "fail", jobId: j, payload: { errorCode: c, errorMessage: m } }); return overrides.failImpl?.(c, m) ?? ({ ok: true }); },
    };
    return { calls, client };
}
interface DockerBehavior {
    owned: string[];
    notOwned?: Set<string>;
    removeImpl?: (name: string) => Promise<void>;
}
function fakeDocker(behavior: DockerBehavior & {
    pullImpl?: () => Promise<string>;
    createImpl?: () => Promise<Record<string, unknown>>;
    healthyImpl?: () => Promise<void>;
} = { owned: [] }) {
    const calls: string[] = [];
    const removedByManager: string[] = [];
    let listed = [...behavior.owned];
    const docker = {
        pullImage: async () => { calls.push("pull"); return `${TRUSTED_REPO}@${GOOD_DIGEST}`; },
        createAndStart: async () => { calls.push("create"); return behavior.createImpl?.() ?? ({ containerName: OWN_NAME }); },
        waitHealthy: async () => { calls.push("healthy"); return behavior.healthyImpl?.(); },
        stopAndRemoveOwned: async (name: string) => {
            calls.push(`assert ${name}`);
            if (behavior.notOwned?.has(name)) {
                throw new EdgeDockerError("EDGE_NOT_OWNED", "refused");
            }
            calls.push(`remove ${name}`);
            if (behavior.removeImpl) {
                await behavior.removeImpl(name);
                return;
            }
            removedByManager.push(name);
            listed = listed.filter((n) => n !== name);
        },
        listOwnedContainers: async () => [...listed],
    };
    return { calls, removedByManager, docker };
}
function cleanupOf(outcome: EdgeOutcome): EdgeCleanupSummary | undefined {
    return "cleanup" in outcome
        ? (outcome as {
            cleanup?: EdgeCleanupSummary;
        }).cleanup
        : undefined;
}
test("cleanup removes an owned container and reports it", async () => {
    const { docker } = fakeDocker({ owned: [OWN_NAME] });
    const summary = await cleanupOwnedContainers(docker as never, IDENTITY);
    assert.deepEqual(summary, {
        attempted: 1, listOk: true, removed: [OWN_NAME], absent: [], notOwned: [], failed: [],
    });
});
test("cleanup reports already-absent when removal races disappearance", async () => {
    const { docker } = fakeDocker({
        owned: [OWN_NAME],
        removeImpl: async () => {
            throw new EdgeDockerError("EDGE_CLEANUP_FAILED", "No such container");
        },
    });
    let listCalls = 0;
    const racy = {
        ...docker,
        listOwnedContainers: async () => (++listCalls === 1 ? [OWN_NAME] : []),
    };
    const summary = await cleanupOwnedContainers(racy as never, IDENTITY);
    assert.deepEqual(summary.removed, []);
    assert.deepEqual(summary.absent, [OWN_NAME]);
    assert.deepEqual(summary.failed, []);
});
test("cleanup reports failure when the container persists", async () => {
    const { docker } = fakeDocker({
        owned: [OWN_NAME],
        removeImpl: async () => {
            throw new EdgeDockerError("EDGE_CLEANUP_FAILED", "device busy");
        },
    });
    const summary = await cleanupOwnedContainers(docker as never, IDENTITY);
    assert.deepEqual(summary.absent, []);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].name, OWN_NAME);
    assert.equal(summary.failed[0].code, "EDGE_CLEANUP_FAILED");
});
test("cleanup never deletes on ownership-label mismatch", async () => {
    const { calls, removedByManager, docker } = fakeDocker({
        owned: [OWN_NAME],
        notOwned: new Set([OWN_NAME]),
    });
    const summary = await cleanupOwnedContainers(docker as never, IDENTITY);
    assert.deepEqual(summary.notOwned, [OWN_NAME]);
    assert.deepEqual(summary.removed, []);
    assert.deepEqual(removedByManager, [], "manager remove must never run for a mismatch");
    assert.ok(!calls.some((c) => c.startsWith("remove ")), "no removal attempted");
});
test("cleanup listing failure is explicit, not silent", async () => {
    const { docker } = fakeDocker({ owned: [OWN_NAME] });
    const blind = {
        ...docker,
        listOwnedContainers: async (): Promise<string[]> => { throw new Error("socket hung up"); },
    };
    const summary = await cleanupOwnedContainers(blind as never, IDENTITY);
    assert.equal(summary.listOk, false);
    assert.equal(summary.attempted, 0);
});
test("repeated cleanup is idempotent", async () => {
    const { docker } = fakeDocker({ owned: [OWN_NAME] });
    const first = await cleanupOwnedContainers(docker as never, IDENTITY);
    assert.deepEqual(first.removed, [OWN_NAME]);
    const second = await cleanupOwnedContainers(docker as never, IDENTITY);
    assert.equal(second.attempted, 0);
    assert.deepEqual(second.removed, []);
});
test("name conflict after failed cleanup stays failed, never succeeds", async () => {
    const client = fakeClient();
    const { docker } = fakeDocker({
        owned: [OWN_NAME],
        removeImpl: async () => {
            throw new EdgeDockerError("EDGE_CLEANUP_FAILED", "device busy");
        },
        createImpl: async () => {
            throw new EdgeDockerError("EDGE_START_FAILED", "Conflict. The container name is already in use");
        },
    });
    const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker as never, heartbeatIntervalMs: 1000 }, AbortSignal.timeout(30000));
    assert.equal(outcome.result, "failed");
    const summary = cleanupOf(outcome);
    assert.ok(summary, "cleanup status must ride along on the failed outcome");
    assert.equal(summary.failed.length, 2);
    assert.ok((outcome as {
        message: string;
    }).message.includes("cleanup incomplete (2 removal failed)"), "failure message must disclose the leftover");
    assert.ok(client.calls.some((c) => c.method === "fail"), "failure reported");
    assert.ok(!client.calls.some((c) => c.method === "complete"), "never completed");
});
test("cleanup failure plus phase failure never produces success", async () => {
    const client = fakeClient();
    const { docker } = fakeDocker({
        owned: [],
        healthyImpl: async () => { throw new EdgeDockerError("EDGE_HEALTH_CHECK_FAILED", "unhealthy"); },
    });
    let runs = 0;
    const sticky = {
        ...docker,
        listOwnedContainers: async () => (++runs <= 1 ? [] : [OWN_NAME]),
        stopAndRemoveOwned: async () => {
            throw new EdgeDockerError("EDGE_CLEANUP_FAILED", "device busy");
        },
    };
    const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: sticky as never, heartbeatIntervalMs: 1000 }, AbortSignal.timeout(30000));
    assert.equal(outcome.result, "failed");
    assert.notEqual(outcome.result, "succeeded");
    assert.ok(client.calls.some((c) => c.method === "fail"));
    assert.ok(!client.calls.some((c) => c.method === "complete"));
});
test("cleanup trouble on the lease-lost path is attached, kind unchanged", async () => {
    const client = fakeClient({
        heartbeatImpl: () => { throw new EdgeApiDefinitiveError("EDGE_GONE", "gone", 404); },
    });
    const { docker } = fakeDocker({
        owned: [OWN_NAME],
        removeImpl: async () => { throw new EdgeDockerError("EDGE_CLEANUP_FAILED", "device busy"); },
    });
    const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker as never, heartbeatIntervalMs: 1000 }, AbortSignal.timeout(30000));
    assert.equal(outcome.result, "lease-lost");
    const summary = cleanupOf(outcome);
    assert.ok(summary, "lease-lost must carry the cleanup status");
    assert.equal(summary.failed.length, 1);
});
test("clean cleanup leaves outcomes untouched (no empty annotation)", async () => {
    const client = fakeClient({
        heartbeatImpl: () => { throw new EdgeApiDefinitiveError("EDGE_GONE", "gone", 404); },
    });
    const { docker } = fakeDocker({ owned: [] });
    const outcome = await runEdgeDeploymentOnce({ client: client.client, docker: docker as never, heartbeatIntervalMs: 1000 }, AbortSignal.timeout(30000));
    assert.equal(outcome.result, "lease-lost");
    assert.equal(cleanupOf(outcome), undefined);
});
