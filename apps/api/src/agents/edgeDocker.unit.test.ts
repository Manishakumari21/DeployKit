// Phase 12.4: edge Docker abstraction tests (fakes; no Docker daemon).
import test from "node:test";
import assert from "node:assert/strict";

import {
  EDGE_AGENT_LABEL,
  EDGE_DEPLOYMENT_LABEL,
  EDGE_MANAGED_LABEL,
  EDGE_PROJECT_LABEL,
  EdgeDockerError,
  EdgeDockerRuntime,
  edgeContainerName,
  resolveEdgeRuntimeConfig,
} from "./edgeDocker.js";
import type { ExecResult } from "../infrastructure/process/dockerExec.js";
import type { RuntimeInfo, RuntimeManager } from "../infrastructure/runtime/runtimeManager.js";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "44444444-4444-4434-8344-444444444444";
const OTHER_DEPLOYMENT = "55555555-5555-4555-8555-555555555555";
const GOOD_IMAGE = `registry.local:5000/deploykit/project-aaaaaaaa@sha256:${"c".repeat(64)}`;

const IDENTITY = { deploymentId: DEPLOYMENT_ID, projectId: PROJECT_ID, agentId: AGENT_ID };
const OWN_NAME = edgeContainerName(PROJECT_ID, DEPLOYMENT_ID);

function okResult(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, timedOut: false, aborted: false };
}

function fakeManager(overrides: Partial<RuntimeManager> = {}): RuntimeManager & { calls: string[] } {
  const calls: string[] = [];
  const runtime: RuntimeInfo = {
    containerId: "d".repeat(64),
    containerName: OWN_NAME,
    containerPort: 3000,
    ipAddress: "172.18.0.5",
    networkName: "deploykit-runtime",
    healthPath: "/",
  };
  return {
    calls,
    pull: async (ref: string) => { calls.push(`pull ${ref}`); await overrides.pull?.(ref); },
    create: async (spec) => { calls.push(`create ${spec.containerName} ${spec.imageReference}`); return overrides.create ? overrides.create(spec) : runtime; },
    start: async (name: string) => { calls.push(`start ${name}`); await overrides.start?.(name); },
    stop: async (name: string) => { calls.push(`stop ${name}`); await overrides.stop?.(name); },
    remove: async (name: string) => { calls.push(`remove ${name}`); await overrides.remove?.(name); },
    inspect: async (name: string) => { calls.push(`inspect ${name}`); return overrides.inspect ? overrides.inspect(name) : runtime; },
    waitForHealthy: async () => { calls.push("healthy"); await overrides.waitForHealthy?.(runtime, 1); },
  };
}

function labelsRunFn(labels: Record<string, string> | null): (binary: string, args: string[]) => Promise<ExecResult> {
  return async (_binary: string, _args: string[]) =>
    labels === null ? { ...okResult(), code: 1, stderr: "no such container" } : okResult(JSON.stringify(labels));
}

function ownedLabels(): Record<string, string> {
  return {
    [EDGE_MANAGED_LABEL]: "true",
    [EDGE_DEPLOYMENT_LABEL]: DEPLOYMENT_ID,
    [EDGE_PROJECT_LABEL]: PROJECT_ID,
    [EDGE_AGENT_LABEL]: AGENT_ID,
  };
}

test("container names are deterministic, bounded, and convention-checked", () => {
  assert.equal(OWN_NAME, `dk-p${PROJECT_ID.replace(/-/g, "").slice(0, 8)}-d${DEPLOYMENT_ID.replace(/-/g, "").slice(0, 8)}`);
  assert.match(OWN_NAME, /^dk-p[0-9a-f]{8}-d[0-9a-f]{8}$/);
  assert.throws(() => edgeContainerName("nope", DEPLOYMENT_ID), EdgeDockerError);
  assert.throws(() => edgeContainerName(PROJECT_ID, "nope"), EdgeDockerError);
});

test("rejects unsafe runtime configuration", () => {
  assert.throws(() => resolveEdgeRuntimeConfig({ networkName: "host" }), /Host networking/);
  assert.throws(() => resolveEdgeRuntimeConfig({ networkName: "evil;net" }), /network/);
  assert.throws(() => resolveEdgeRuntimeConfig({ memoryBytes: 1024 }), /memoryBytes/);
  assert.throws(() => resolveEdgeRuntimeConfig({ memoryBytes: 64 * 1024 * 1024 * 1024 }), /memoryBytes/);
  assert.throws(() => resolveEdgeRuntimeConfig({ cpuLimit: 0 }), /cpuLimit/);
  assert.throws(() => resolveEdgeRuntimeConfig({ cpuLimit: 64 }), /cpuLimit/);
  assert.throws(() => resolveEdgeRuntimeConfig({ healthPath: "no-slash" }), /Health path/);
  assert.throws(() => resolveEdgeRuntimeConfig({ healthTimeoutMs: 1 }), /healthTimeoutMs/);
  assert.throws(() => resolveEdgeRuntimeConfig({ healthTimeoutMs: 3_600_000 }), /healthTimeoutMs/);
  const defaults = resolveEdgeRuntimeConfig({});
  assert.equal(defaults.memoryBytes, 512 * 1024 * 1024);
  assert.equal(defaults.cpuLimit, 1);
  assert.equal(defaults.healthTimeoutMs, 60_000);
});

test("pull refuses mutable tags and malformed digests", async () => {
  const rt = new EdgeDockerRuntime({ runtimeManager: fakeManager() });
  await assert.rejects(rt.pullImage("registry.local/app:latest"), EdgeDockerError);
  await assert.rejects(rt.pullImage("registry.local/app@sha256:short"), EdgeDockerError);
  const pinned = await rt.pullImage(GOOD_IMAGE);
  assert.equal(pinned, GOOD_IMAGE);
});

test("create/start uses the hardened runtime contract", async () => {
  const manager = fakeManager();
  let seenSpec: Parameters<RuntimeManager["create"]>[0] | null = null;
  const capturing = fakeManager({
    create: async (spec) => {
      seenSpec = spec;
      return {
        containerId: "e".repeat(64),
        containerName: spec.containerName,
        containerPort: spec.containerPort,
        ipAddress: "",
        networkName: spec.networkName,
        healthPath: spec.healthPath,
      };
    },
  });
  void manager;
  const rt = new EdgeDockerRuntime({ runtimeManager: capturing });
  await rt.createAndStart(IDENTITY, GOOD_IMAGE);
  assert.ok(seenSpec);
  const spec = seenSpec as unknown as Record<string, unknown>;
  assert.equal(spec.containerName, OWN_NAME);
  assert.equal(spec.imageReference, GOOD_IMAGE);
  assert.equal(spec.networkName, "deploykit-runtime");
  assert.deepEqual(spec.labels, {
    "io.deploykit.deployment": DEPLOYMENT_ID,
    "io.deploykit.project": PROJECT_ID,
    "io.deploykit.agent": AGENT_ID,
  });
  const env = spec.environment as Record<string, string>;
  assert.ok(!Object.keys(env).join(" ").match(/token|secret|password|key/i), "no secrets in environment");
});

test("ownership gate refuses foreign or unlabeled containers", async () => {
  const strangerName = edgeContainerName(PROJECT_ID, OTHER_DEPLOYMENT);
  const rt = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: (async () => okResult(JSON.stringify(ownedLabels()))) as never,
  });
  // Name bound to another deployment: refuse before even inspecting.
  await assert.rejects(rt.assertOwned(strangerName, IDENTITY), (e: unknown) => e instanceof EdgeDockerError && e.code === "EDGE_NOT_OWNED");
  // Missing managed label.
  const noManaged = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: labelsRunFn({ [EDGE_DEPLOYMENT_LABEL]: DEPLOYMENT_ID }) as never,
  });
  await assert.rejects(noManaged.assertOwned(OWN_NAME, IDENTITY), (e: unknown) => e instanceof EdgeDockerError && e.code === "EDGE_NOT_OWNED");
  // Labels of another agent.
  const foreign = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: labelsRunFn({ ...ownedLabels(), [EDGE_AGENT_LABEL]: "66666666-6666-4666-8666-666666666666" }) as never,
  });
  await assert.rejects(foreign.assertOwned(OWN_NAME, IDENTITY), (e: unknown) => e instanceof EdgeDockerError && e.code === "EDGE_NOT_OWNED");
  // Missing container: refuse (never assume ownership).
  const missing = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: labelsRunFn(null) as never,
  });
  await assert.rejects(missing.assertOwned(OWN_NAME, IDENTITY), (e: unknown) => e instanceof EdgeDockerError && e.code === "EDGE_NOT_OWNED");
  // Owned: passes.
  await rt.assertOwned(OWN_NAME, IDENTITY);
});

test("stop/remove only touches proven-owned containers", async () => {
  const manager = fakeManager();
  const rt = new EdgeDockerRuntime({
    runtimeManager: manager,
    runFn: labelsRunFn(ownedLabels()) as never,
  });
  await rt.stopAndRemoveOwned(OWN_NAME, IDENTITY);
  assert.ok(manager.calls.includes(`stop ${OWN_NAME}`));
  assert.ok(manager.calls.includes(`remove ${OWN_NAME}`));

  const refused = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: labelsRunFn(null) as never,
  });
  await assert.rejects(refused.stopAndRemoveOwned(OWN_NAME, IDENTITY), (e: unknown) => e instanceof EdgeDockerError && e.code === "EDGE_NOT_OWNED");
});

test("listing filters to owned deployment names only", async () => {
  const rt = new EdgeDockerRuntime({
    runtimeManager: fakeManager(),
    runFn: (async (_b: string, args: string[]) => {
      assert.ok(args.includes(`${EDGE_DEPLOYMENT_LABEL}=${DEPLOYMENT_ID}`), "label filter must scope the listing");
      return okResult(`${OWN_NAME}\nnot-our-container\ndk-gateway\n`);
    }) as never,
  });
  const names = await rt.listOwnedContainers(DEPLOYMENT_ID);
  assert.deepEqual(names, [OWN_NAME], "unrelated containers must never enter the owned set");
});
