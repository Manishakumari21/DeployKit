import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GC_KEEP_RELEASES,
  MAX_GC_KEEP_RELEASES,
  MIN_GC_KEEP_RELEASES,
  buildRegistryManifestDeleteRequest,
  classifyManifestDeleteStatus,
  manifestPathFromRepository,
  readRegistryGcOptions,
  registryGarbageCollectArgs,
  selectPrunableRegistryImages,
} from "./registryGarbageCollector.js";
import type { RegistryCredentials } from "./registryAuth.js";
import type { RegistryConfig } from "./registryConfig.js";

type Row = Parameters<typeof selectPrunableRegistryImages>[0][number];

function wrap(digestHex: string): string {
  return `sha256:${digestHex.padEnd(64, "0").slice(0, 64)}`;
}

function hexOf(value: string): string {
  let out = "";
  for (const char of value) {
    out += char.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return out;
}

function row(input: {
  project: string;
  repo?: string;
  digest?: string;
  status: string;
  createdAt: string;
}): Row {
  return {
    project_id: input.project,
    image_repository:
      input.repo ?? `reg.example.com/deploykit/project-${input.project}`,
    image_digest: input.digest ?? wrap(hexOf(input.createdAt)),
    status: input.status,
    created_at: input.createdAt,
  };
}

test("readRegistryGcOptions applies defaults", () => {
  assert.deepEqual(readRegistryGcOptions({}), {
    enabled: true,
    keepReleases: DEFAULT_GC_KEEP_RELEASES,
  });
});

test("readRegistryGcOptions parses and clamps the keep window", () => {
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES: "5" })
      .keepReleases,
    5
  );
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES: "0" })
      .keepReleases,
    MIN_GC_KEEP_RELEASES
  );
  assert.equal(
    readRegistryGcOptions({
      DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES: String(MAX_GC_KEEP_RELEASES * 10),
    }).keepReleases,
    MAX_GC_KEEP_RELEASES
  );
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES: "junk" })
      .keepReleases,
    DEFAULT_GC_KEEP_RELEASES
  );
});

test("readRegistryGcOptions fails closed on an ambiguous enable flag", () => {
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_ENABLED: "true" }).enabled,
    true
  );
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_ENABLED: "false" }).enabled,
    false
  );
  assert.equal(
    readRegistryGcOptions({ DEPLOYKIT_REGISTRY_GC_ENABLED: "maybe" }).enabled,
    false
  );
});

test("selectPrunableRegistryImages keeps active releases beyond the window", () => {
  const old = row({ project: "p1", status: "active", createdAt: "2020-01-01" });
  const rows: Row[] = [old];
  for (let i = 0; i < DEFAULT_GC_KEEP_RELEASES; i += 1) {
    rows.push(
      row({ project: "p1", status: "stopped", createdAt: `2020-02-${String(i + 1).padStart(2, "0")}` })
    );
  }
  assert.deepEqual(selectPrunableRegistryImages(rows), []);
});

test("selectPrunableRegistryImages prunes releases older than the per-project window", () => {
  const project = "p1";
  const rows: Row[] = [
    row({ project, status: "active", createdAt: "2020-01-01T00:00:00Z" }),
  ];
  for (let i = 0; i < DEFAULT_GC_KEEP_RELEASES + 3; i += 1) {
    rows.push(
      row({
        project,
        status: "stopped",
        digest: `sha256:cd${String(i).padStart(2, "0")}${"0".repeat(60)}`,
        createdAt: `202${String(i + 1).slice(-1)}-0${(i % 8) + 1}-1${i % 10}T00:00:00Z`,
      })
    );
  }
  const prunable = selectPrunableRegistryImages(rows);
  // Active + newest KEEP stay; everything older becomes garbage.
  assert.equal(prunable.length, 3);
});

test("selectPrunableRegistryImages isolates the window per project", () => {
  const rows: Row[] = [
    row({ project: "p1", status: "stopped", createdAt: "2021-01-01T00:00:00Z" }),
    row({ project: "p1", status: "stopped", createdAt: "2021-01-20T00:00:00Z" }),
    row({ project: "p2", status: "stopped", createdAt: "2021-02-01T00:00:00Z" }),
    row({ project: "p2", status: "stopped", createdAt: "2021-03-01T00:00:00Z" }),
  ];
  const prunable = selectPrunableRegistryImages(rows, 1);
  assert.equal(prunable.length, 2, "exactly the older release of each project");
});

test("selectPrunableRegistryImages protects digests shared with a kept release", () => {
  const shared = `sha256:${"ef".repeat(31)}ab`;
  // Rollback re-creates the newest release row pointing at the old digest.
  const rows: Row[] = [
    row({
      project: "p1",
      digest: shared,
      status: "stopped",
      createdAt: "2020-01-01T00:00:00Z",
    }),
    row({
      project: "p1",
      digest: shared,
      status: "stopped",
      createdAt: "2021-12-31T00:00:00Z",
    }),
  ];
  const prunable = selectPrunableRegistryImages(rows, 1);
  assert.deepEqual(prunable, []);
});

test("selectPrunableRegistryImages ignores failed releases and malformed digests", () => {
  const rows: Row[] = [
    row({ project: "p1", status: "failed", createdAt: "2020-01-01T00:00:00Z" }),
    {
      project_id: "p1",
      image_repository: "reg.example.com/deploykit/project-p1",
      image_digest: "not-a-digest",
      status: "stopped",
      created_at: "2020-06-01T00:00:00Z",
    },
    {
      project_id: "p1",
      image_repository: null,
      image_digest: "sha256:a",
      status: "stopped",
      created_at: "2020-07-01T00:00:00Z",
    },
  ];
  assert.deepEqual(selectPrunableRegistryImages(rows), []);
});

test("manifestPathFromRepository strips the registry host and rejects foreign repos", () => {
  const config: RegistryConfig = {
    registryHost: "reg.example.com",
    namespace: "deploykit",
    insecure: false,
  };
  assert.equal(
    manifestPathFromRepository("reg.example.com/deploykit/project-abcd1234", config),
    "deploykit/project-abcd1234"
  );
  assert.equal(
    manifestPathFromRepository("other.example.com/deploykit/project-abcd1234", config),
    null
  );
  assert.equal(
    manifestPathFromRepository("reg.example.com/deploykit/project-abcd1234"),
    "deploykit/project-abcd1234"
  );
  assert.equal(manifestPathFromRepository("only-host/path with space"), null);
});

test("buildRegistryManifestDeleteRequest builds a TLS DELETE with auth", () => {
  const credentials: RegistryCredentials = { username: "u", password: "p" };
  const request = buildRegistryManifestDeleteRequest({
    registryHost: "reg.example.com",
    repositoryPath: "deploykit/project-abcd1234",
    digest: `sha256:${"11".repeat(32)}`,
    credentials,
  });
  assert.equal(request.protocol, "https:");
  assert.equal(request.host, "reg.example.com");
  assert.equal(request.port, "443");
  assert.equal(request.path, `/v2/deploykit/project-abcd1234/manifests/sha256:${"11".repeat(32)}`);
  assert.match(request.headers.Authorization ?? "", /^Basic [A-Za-z0-9+/=]+$/);
  const encoded = (/^Basic (.*)$/.exec(request.headers.Authorization ?? "") ?? ["", ""])[1];
  assert.equal(Buffer.from(encoded, "base64").toString(), "u:p");
  assert.ok(request.headers.Accept.includes("manifest"));
  assert.ok((request.timeoutMs ?? 0) > 0);
});
test("buildRegistryManifestDeleteRequest drops to http only when insecure", () => {
  const noTls = buildRegistryManifestDeleteRequest({
    registryHost: "deploykit-registry",
    repositoryPath: "deploykit/project-1",
    digest: `sha256:${"22".repeat(32)}`,
    insecure: true,
  });
  assert.equal(noTls.protocol, "http:");
  assert.equal(noTls.port, "80");
  assert.equal(noTls.caPem, undefined);
});

test("buildRegistryManifestDeleteRequest honors an explicit insecure port", () => {
  const request = buildRegistryManifestDeleteRequest({
    registryHost: "127.0.0.1:5000",
    repositoryPath: "n/p",
    digest: `sha256:${"33".repeat(32)}`,
    insecure: true,
  });
  assert.equal(request.protocol, "http:");
  assert.equal(request.port, "5000");
});

test("classifyManifestDeleteStatus maps registry responses", () => {
  assert.equal(classifyManifestDeleteStatus(202), "deleted");
  assert.equal(classifyManifestDeleteStatus(404), "missing");
  assert.equal(classifyManifestDeleteStatus(405), "deletion-disabled");
  assert.equal(classifyManifestDeleteStatus(401), "unauthorized");
  assert.equal(classifyManifestDeleteStatus(500), "error");
});

test("registryGarbageCollectArgs execs garbage-collect inside the registry container", () => {
  assert.deepEqual(registryGarbageCollectArgs("deploykit-registry", "/etc/docker/registry/config.yml"), [
    "exec",
    "deploykit-registry",
    "registry",
    "garbage-collect",
    "/etc/docker/registry/config.yml",
  ]);
});
