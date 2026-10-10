
import test from "node:test";
import assert from "node:assert/strict";

import {
  EdgeAgentConfigError,
  parseEdgeAgentConfig,
} from "./edgeAgentConfig.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DEPLOYKIT_CONTROL_PLANE_URL: "https://control.example.com",
    DEPLOYKIT_AGENT_TOKEN: "a".repeat(64),
  };
}

test("missing required configuration fails closed without echoing values", () => {
  assert.throws(() => parseEdgeAgentConfig({}), EdgeAgentConfigError);
  assert.throws(
    () => parseEdgeAgentConfig({ DEPLOYKIT_CONTROL_PLANE_URL: "https://cp.example.com" }),
    /DEPLOYKIT_AGENT_TOKEN is required/
  );
  assert.throws(
    () => parseEdgeAgentConfig({ DEPLOYKIT_AGENT_TOKEN: "b".repeat(64) }),
    /DEPLOYKIT_CONTROL_PLANE_URL is required/
  );
});

test("invalid control-plane URLs are rejected", () => {
  for (const url of [
    "not-a-url",
    "ftp://control.example.com",
    "https://control.example.com/api/v1",
    "https://control.example.com?x=1",
    "https://control.example.com#frag",
    "https://user:pass@control.example.com",
    "https://control.example.com:99999",
    "https://",
  ]) {
    assert.throws(
      () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_CONTROL_PLANE_URL: url }),
      EdgeAgentConfigError,
      url
    );
  }
});

test("non-local HTTP is rejected; loopback and explicit opt-in are allowed", () => {

  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_CONTROL_PLANE_URL: "http://control.example.com" }),
    /Plain HTTP/
  );

  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://host.docker.internal:3000",
  ]) {
    const cfg = parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_CONTROL_PLANE_URL: url });
    assert.ok(cfg.controlPlaneUrl.startsWith("http://"));
  }

  const https = parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_CONTROL_PLANE_URL: "https://control.example.com:8443" });
  assert.equal(https.controlPlaneUrl, "https://control.example.com:8443");

  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_CONTROL_PLANE_URL: "http://api:3000" }),
    /Plain HTTP/
  );
  const opted = parseEdgeAgentConfig({
    ...baseEnv(),
    DEPLOYKIT_CONTROL_PLANE_URL: "http://api:3000",
    DEPLOYKIT_EDGE_ALLOW_HTTP: "true",
  });
  assert.equal(opted.controlPlaneUrl, "http://api:3000");
  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_EDGE_ALLOW_HTTP: "maybe" }),
    /DEPLOYKIT_EDGE_ALLOW_HTTP/
  );
});

test("TLS verification cannot be disabled", () => {
  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    /TLS verification/
  );
  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_EDGE_INSECURE_TLS: "true" }),
    /TLS verification/
  );
  assert.throws(
    () => parseEdgeAgentConfig({ ...baseEnv(), DEPLOYKIT_EDGE_TLS_INSECURE: "1" }),
    /TLS verification/
  );

  parseEdgeAgentConfig({ ...baseEnv(), NODE_TLS_REJECT_UNAUTHORIZED: "1" });
});

test("invalid polling intervals and timeouts are rejected; bounds hold", () => {
  for (const [name, bad] of [
    ["DEPLOYKIT_EDGE_POLL_INTERVAL_MS", "0"],
    ["DEPLOYKIT_EDGE_POLL_INTERVAL_MS", "5.5"],
    ["DEPLOYKIT_EDGE_POLL_INTERVAL_MS", "not-a-number"],
    ["DEPLOYKIT_EDGE_POLL_INTERVAL_MS", "60001"],
    ["DEPLOYKIT_EDGE_REQUEST_TIMEOUT_MS", "999"],
    ["DEPLOYKIT_EDGE_REQUEST_TIMEOUT_MS", "120001"],
    ["DEPLOYKIT_EDGE_HEARTBEAT_INTERVAL_MS", "999"],
    ["DEPLOYKIT_EDGE_EXECUTION_TIMEOUT_MS", "29999"],
    ["DEPLOYKIT_EDGE_EXECUTION_TIMEOUT_MS", "3600001"],
  ] as const) {
    assert.throws(
      () => parseEdgeAgentConfig({ ...baseEnv(), [name]: bad }),
      EdgeAgentConfigError,
      `${name}=${bad}`
    );
  }
  const cfg = parseEdgeAgentConfig(baseEnv());
  assert.equal(cfg.pollIntervalMs, 5_000);
  assert.equal(cfg.requestTimeoutMs, 15_000);
  assert.equal(cfg.heartbeatIntervalMs, 10_000);
  assert.equal(cfg.executionTimeoutMs, 600_000);
  const custom = parseEdgeAgentConfig({
    ...baseEnv(),
    DEPLOYKIT_EDGE_POLL_INTERVAL_MS: "1000",
    DEPLOYKIT_EDGE_REQUEST_TIMEOUT_MS: "120000",
  });
  assert.equal(custom.pollIntervalMs, 1_000);
  assert.equal(custom.requestTimeoutMs, 120_000);
});

test("credentials and identities are validated, never echoed", () => {
  const token = "super-secret-token-value";
  for (const env of [
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: "" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: "has space in it here" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: "short" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_EDGE_POLL_INTERVAL_MS: "bogus" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_AGENT_ID: "not-a-uuid" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_LOG_LEVEL: "verbose" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_DOCKER_BINARY: "docker; rm -rf /" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_EDGE_NETWORK: "host;evil" },
    { ...baseEnv(), DEPLOYKIT_AGENT_TOKEN: token, DEPLOYKIT_EDGE_HEALTH_PATH: "no-slash" },
  ]) {
    try {
      parseEdgeAgentConfig(env);
      assert.fail("expected EdgeAgentConfigError");
    } catch (error) {
      assert.ok(error instanceof EdgeAgentConfigError);
      assert.ok(!error.message.includes(token), "token must not appear in config errors");
      assert.ok(!error.message.includes("super-secret"), "token must not appear in config errors");
    }
  }
  const withId = parseEdgeAgentConfig({
    ...baseEnv(),
    DEPLOYKIT_AGENT_ID: "44444444-4444-4434-8344-444444444444",
    DEPLOYKIT_LOG_LEVEL: "debug",
  });
  assert.equal(withId.agentId, "44444444-4444-4434-8344-444444444444");
  assert.equal(withId.logLevel, "debug");
  assert.equal(parseEdgeAgentConfig(baseEnv()).agentId, null);
});
