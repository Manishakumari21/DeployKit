import test from "node:test";
import assert from "node:assert/strict";

import {
  routeServerName,
  validateRouteTarget,
  TrafficRouterError,
} from "./trafficRouter.js";
import {
  parseProjectRoute,
  renderProjectRoute,
} from "./nginxGatewayRouter.js";

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE = "abcdefab-abcd-abcd-abcd-abcdefabcdef";

function target() {
  return {
    projectId: PROJECT,
    releaseId: RELEASE,
    containerName: "dk-p12345678-dabcdefab",
    containerIp: "172.20.0.5",
    containerPort: 3000,
  };
}

test("valid route target passes validation", () => {
  assert.deepEqual(validateRouteTarget(target()), target());
});

test("invalid routing targets are rejected", () => {
  const bad = [
    { ...target(), projectId: "not-a-uuid" },
    { ...target(), releaseId: "xyz" },
    { ...target(), containerName: "../evil" },
    { ...target(), containerName: "BAD NAME!" },
    { ...target(), containerIp: "999.1.1.1" },
    { ...target(), containerIp: "localhost" },
    { ...target(), containerIp: "::1" },
    { ...target(), containerPort: 0 },
    { ...target(), containerPort: 70000 },
  ];
  for (const t of bad) {
    assert.throws(() => validateRouteTarget(t), (error: unknown) => {
      assert.ok(error instanceof TrafficRouterError);
      return true;
    });
  }
});

test("server name is deterministic and rejects bad projects", () => {
  assert.equal(routeServerName(PROJECT), "dk-p12345678.deploykit.local");
  assert.throws(() => routeServerName("nope"), (error: unknown) => {
    assert.ok(error instanceof TrafficRouterError);
    return true;
  });
});

test("rendered config round-trips through the parser", () => {
  const content = renderProjectRoute(target());
  assert.match(content, /server_name dk-p12345678\.deploykit\.local/);
  assert.match(content, /server 172\.20\.0\.5:3000/);
  assert.deepEqual(parseProjectRoute(PROJECT, content), target());
});

test("parser rejects mismatched or tampered configs", () => {
  const content = renderProjectRoute(target());
  assert.equal(parseProjectRoute("87654321-4321-4321-4321-cba987654321", content), null);
  assert.equal(parseProjectRoute(PROJECT, "server { }"), null);
  assert.equal(
    parseProjectRoute(PROJECT, content.replace("172.20.0.5", "1.2.3.4; evil")),
    null
  );
});
