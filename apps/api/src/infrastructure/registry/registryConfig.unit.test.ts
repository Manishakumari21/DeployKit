import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImageReference,
  digestReference,
  getOptionalRegistryConfig,
  getRegistryConfig,
  isRegistryConfigured,
  registryRepositoryForProject,
  registryTagForDeployment,
  validateImageDigest,
  validateRegistryHost,
  validateRegistryNamespace,
  validateRegistryRepository,
  validateRegistryTag,
} from "./registryConfig.js";

const ENV_KEYS = [
  "DEPLOYKIT_REGISTRY_HOST",
  "DEPLOYKIT_REGISTRY_NAMESPACE",
  "DEPLOYKIT_REGISTRY_INSECURE",
] as const;

function withRegistryEnv(
  values: Record<string, string | undefined>,
  fn: () => void
): void {
  const previous = new Map<string, string | undefined>();

  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);

    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("valid registry hosts are accepted", () => {
  assert.equal(
    validateRegistryHost("deploykit-registry:5000"),
    "deploykit-registry:5000"
  );
  assert.equal(validateRegistryHost("localhost:5000"), "localhost:5000");
  assert.equal(
    validateRegistryHost("registry.example.com"),
    "registry.example.com"
  );
  assert.equal(
    validateRegistryHost("registry.example.com:443"),
    "registry.example.com:443"
  );
});

test("registry host rejects scheme, credentials, whitespace, controls", () => {
  assert.throws(() => validateRegistryHost("http://localhost:5000"));
  assert.throws(() => validateRegistryHost("https://registry:5000"));
  assert.throws(() => validateRegistryHost("user:pass@localhost:5000"));
  assert.throws(() => validateRegistryHost("user@localhost:5000"));
  assert.throws(() => validateRegistryHost("local host:5000"));
  assert.throws(() => validateRegistryHost("localhost:5000/path"));
  assert.throws(() => validateRegistryHost("local\nhost:5000"));
  assert.throws(() => validateRegistryHost("local\thost"));
  assert.throws(() => validateRegistryHost(""));
  assert.throws(() => validateRegistryHost("localhost:99999"));
  assert.throws(() => validateRegistryHost("a".repeat(256)));
});

test("registry namespace validation", () => {
  assert.equal(validateRegistryNamespace("deploykit"), "deploykit");
  assert.equal(validateRegistryNamespace("team.app-1"), "team.app-1");
  assert.throws(() => validateRegistryNamespace(""));
  assert.throws(() => validateRegistryNamespace("DeployKit"));
  assert.throws(() => validateRegistryNamespace("-leading"));
  assert.throws(() => validateRegistryNamespace("trailing-"));
  assert.throws(() => validateRegistryNamespace("has space"));
  assert.throws(() => validateRegistryNamespace("has/slash"));
  assert.throws(() => validateRegistryNamespace("double--dash-ok".toUpperCase()));
});

test("insecure mode is restricted to local targets", () => {
  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "localhost:5000",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: "true",
    },
    () => {
      const config = getRegistryConfig();
      assert.equal(config.insecure, true);
    }
  );

  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "deploykit-registry:5000",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: "true",
    },
    () => {
      assert.equal(getRegistryConfig().insecure, true);
    }
  );

  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "registry.example.com",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: "true",
    },
    () => {
      assert.throws(() => getRegistryConfig());
    }
  );

  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "registry.example.com",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: undefined,
    },
    () => {
      assert.equal(getRegistryConfig().insecure, false);
    }
  );

  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "localhost:5000",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: "maybe",
    },
    () => {
      assert.throws(() => getRegistryConfig());
    }
  );
});

test("unconfigured registry returns null instead of throwing", () => {
  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: undefined,
      DEPLOYKIT_REGISTRY_NAMESPACE: undefined,
      DEPLOYKIT_REGISTRY_INSECURE: undefined,
    },
    () => {
      assert.equal(getOptionalRegistryConfig(), null);
      assert.equal(isRegistryConfigured(), false);
    }
  );

  withRegistryEnv(
    {
      DEPLOYKIT_REGISTRY_HOST: "localhost:5000",
      DEPLOYKIT_REGISTRY_NAMESPACE: "deploykit",
      DEPLOYKIT_REGISTRY_INSECURE: "true",
    },
    () => {
      assert.notEqual(getOptionalRegistryConfig(), null);
      assert.equal(isRegistryConfigured(), true);
    }
  );
});

test("image reference helpers are deterministic and validated", () => {
  const repository = "localhost:5000/deploykit/project-abcdef12";
  assert.equal(
    buildImageReference(repository, "d-12345678-abc1234"),
    `${repository}:d-12345678-abc1234`
  );
  assert.equal(
    buildImageReference(repository, "d-12345678-abc1234"),
    buildImageReference(repository, "d-12345678-abc1234")
  );

  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    digestReference(repository, digest),
    `${repository}@${digest}`
  );
  assert.throws(() => buildImageReference("UPPER/repo", "tag"));
  assert.throws(() => buildImageReference(repository, "latest; rm -rf /"));
  assert.throws(() =>
    digestReference(repository, "sha256:short")
  );
});

test("registry naming helpers are deterministic", () => {
  const config = {
    registryHost: "localhost:5000",
    namespace: "deploykit",
    insecure: true,
  };
  const projectId = "11111111-2222-3333-4444-555555555555";
  const deploymentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const commitSha = "a".repeat(40);

  assert.equal(
    registryRepositoryForProject(config, projectId),
    "localhost:5000/deploykit/project-11111111"
  );
  assert.equal(
    registryRepositoryForProject(config, projectId),
    registryRepositoryForProject(config, projectId)
  );
  assert.equal(
    registryTagForDeployment(deploymentId, commitSha),
    "d-aaaaaaaa-aaaaaaa"
  );
  assert.throws(() =>
    registryRepositoryForProject(config, "not-a-uuid")
  );
  assert.throws(() =>
    registryTagForDeployment(deploymentId, "short")
  );
});

test("digest and tag validators", () => {
  assert.equal(validateImageDigest(`SHA256:${"B".repeat(64)}`), `sha256:${"b".repeat(64)}`);
  assert.throws(() => validateImageDigest("sha256:xyz"));
  assert.equal(validateRegistryTag("d-abc-123"), "d-abc-123");
  assert.throws(() => validateRegistryTag("latest;evil"));
  assert.throws(() => validateRegistryRepository("singlecomponent"));
  assert.throws(() => validateRegistryRepository("host:999999/namespace/repo"));
});
