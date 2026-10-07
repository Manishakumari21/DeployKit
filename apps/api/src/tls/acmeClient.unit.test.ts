// Phase 11.8: ACME client contract (no network, no filesystem).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACME_PRODUCTION_URL,
  ACME_STAGING_URL,
  FakeAcmeClient,
  getAcmeConfig,
  legoArgsFor,
  AcmeError,
} from "./acmeClient.js";

test("lego argv pins the documented HTTP-01 webroot contract", () => {
  const run = legoArgsFor({
    domain: "Example.COM",
    email: "ops@example.com",
    serverUrl: ACME_STAGING_URL,
    legoPath: "/certs/acme",
    webroot: "/certs/challenges",
    renew: false,
    renewDays: 45,
  });
  assert.deepEqual(run, [
    "--email", "ops@example.com",
    "--domains", "example.com",
    "--server", ACME_STAGING_URL,
    "--path", "/certs/acme",
    "--accept-tos",
    "--http",
    "--http.webroot", "/certs/challenges",
    "run",
  ]);
  const renew = legoArgsFor({
    domain: "example.com",
    email: "ops@example.com",
    serverUrl: ACME_PRODUCTION_URL,
    legoPath: "/certs/acme",
    webroot: "/certs/challenges",
    renew: true,
    renewDays: 45,
  });
  assert.ok(renew.includes("renew"));
  assert.ok(renew.includes("45"));
  assert.ok(!renew.includes("run"));
  // No secrets travel as argv: only email/domain/server/paths.
  assert.ok(!run.join(" ").includes("PRIVATE"));
});

test("ACME config defaults to staging and requires an email", () => {
  const savedEmail = process.env.DEPLOYKIT_ACME_EMAIL;
  const savedServer = process.env.DEPLOYKIT_ACME_SERVER;
  try {
    delete process.env.DEPLOYKIT_ACME_EMAIL;
    delete process.env.DEPLOYKIT_ACME_SERVER;
    assert.throws(() => getAcmeConfig(), (e: unknown) => e instanceof AcmeError);
    process.env.DEPLOYKIT_ACME_EMAIL = "not-an-email";
    assert.throws(() => getAcmeConfig(), (e: unknown) => e instanceof AcmeError);
    process.env.DEPLOYKIT_ACME_EMAIL = "ops@example.com";
    assert.equal(getAcmeConfig().serverUrl, ACME_STAGING_URL);
    process.env.DEPLOYKIT_ACME_SERVER = ACME_PRODUCTION_URL;
    assert.equal(getAcmeConfig().serverUrl, ACME_PRODUCTION_URL);
  } finally {
    if (savedEmail === undefined) delete process.env.DEPLOYKIT_ACME_EMAIL;
    else process.env.DEPLOYKIT_ACME_EMAIL = savedEmail;
    if (savedServer === undefined) delete process.env.DEPLOYKIT_ACME_SERVER;
    else process.env.DEPLOYKIT_ACME_SERVER = savedServer;
  }
});

test("self-signed mode refuses production outright", async () => {
  const saved = process.env.NODE_ENV;
  const { SelfSignedAcmeClient } = await import("./acmeClient.js");
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => new SelfSignedAcmeClient(), (e: unknown) => e instanceof AcmeError);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
});

test("fake client records normalized requests for orchestration tests", async () => {
  const client = new FakeAcmeClient(() => {
    throw new AcmeError("ACME_REQUEST_FAILED", "nope");
  });
  await assert.rejects(client.requestCertificate("Example.COM"));
  assert.deepEqual(client.requests, [{ domain: "example.com" }]);
});
