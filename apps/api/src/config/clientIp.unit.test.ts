
import test from "node:test";
import assert from "node:assert/strict";

import { isTrustedProxyPeer, resolveClientIp } from "./clientIp.js";

test("loopback, private, and link-local peers are trusted; public is not", () => {
  for (const trusted of [
    "127.0.0.1",
    "10.0.4.7",
    "172.18.0.4",
    "172.31.255.1",
    "192.168.1.20",
    "169.254.9.9",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "fe80::1",
  ]) {
    assert.equal(isTrustedProxyPeer(trusted), true, trusted);
  }
  for (const untrusted of [
    "172.15.0.4",
    "172.32.0.1",
    "8.8.8.8",
    "203.0.113.7",
    "2001:db8::1",
    "",
    undefined,
    "not-an-ip",
  ]) {
    assert.equal(isTrustedProxyPeer(untrusted), false, String(untrusted));
  }
});

test("trusted peer uses the last forwarded entry (proxy-appended, attacker entries ignored)", () => {
  assert.equal(
    resolveClientIp({
      socketAddress: "172.18.0.3",
      forwardedFor: "1.2.3.4, 203.0.113.9",
    }),
    "203.0.113.9"
  );

  assert.equal(
    resolveClientIp({ socketAddress: "127.0.0.1", forwardedFor: "198.51.100.7" }),
    "198.51.100.7"
  );
});

test("untrusted direct peers ignore X-Forwarded-For entirely", () => {
  assert.equal(
    resolveClientIp({ socketAddress: "203.0.113.7", forwardedFor: "1.2.3.4" }),
    "203.0.113.7"
  );
  assert.equal(
    resolveClientIp({ socketAddress: undefined, forwardedFor: "1.2.3.4" }),
    "unknown"
  );
});

test("malformed or absent headers fall back to the socket peer", () => {
  assert.equal(
    resolveClientIp({ socketAddress: "172.18.0.3", forwardedFor: "garbage,," }),
    "172.18.0.3"
  );
  assert.equal(
    resolveClientIp({ socketAddress: "172.18.0.3", forwardedFor: undefined }),
    "172.18.0.3"
  );
  assert.equal(
    resolveClientIp({ socketAddress: "172.18.0.3", forwardedFor: ["1.1.1.1", "2.2.2.2"] }),
    "2.2.2.2"
  );
});
