// Phase 11.7: certificate path determinism + traversal safety (no DB/fs).
import test from "node:test";
import assert from "node:assert/strict";
import {
  acmeWorkDir,
  certPathRef,
  CERT_FILE_MODE,
  challengeDir,
  challengeWebroot,
  DOMAIN_DIR_MODE,
  domainCertDir,
  fullchainPath,
  gatewayCertPaths,
  gatewayChallengeRoot,
  PRIVATE_KEY_MODE,
  privateKeyPath,
} from "./certPaths.js";

test("domain certificate paths are deterministic per normalized domain", () => {
  assert.equal(domainCertDir("Example.COM"), domainCertDir("example.com"));
  assert.equal(fullchainPath("example.com"), fullchainPath("EXAMPLE.com."));
  assert.notEqual(fullchainPath("a.example.com"), fullchainPath("b.example.com"));
  assert.ok(fullchainPath("example.com").endsWith("/domains/example.com/fullchain.pem"));
  assert.ok(privateKeyPath("example.com").endsWith("/domains/example.com/private-key.pem"));
  assert.equal(certPathRef("Example.COM"), "domains/example.com");
});

test("gateway paths share the same relative layout under the certs volume", () => {
  const gw = gatewayCertPaths("example.com");
  assert.equal(gw.certificate, "/etc/nginx/certs/domains/example.com/fullchain.pem");
  assert.equal(gw.key, "/etc/nginx/certs/domains/example.com/private-key.pem");
  assert.equal(gatewayChallengeRoot(), "/etc/nginx/certs/challenges");
  assert.ok(challengeDir("/certs").endsWith("challenges/.well-known/acme-challenge"));
  assert.ok(acmeWorkDir("/certs").endsWith("/acme"));
});

test("path helpers reject non-hostname input instead of escaping", () => {
  for (const bad of ["../evil", "a/b", "", "localhost", "*.example.com", "1.2.3.4"]) {
    assert.throws(() => domainCertDir(bad), /./, `must reject ${bad}`);
    assert.throws(() => gatewayCertPaths(bad), /./, `must reject ${bad}`);
  }
});

test("private keys are mode-restricted and distinct from certificates", () => {
  assert.equal(PRIVATE_KEY_MODE, 0o600);
  assert.equal(CERT_FILE_MODE, 0o644);
  assert.equal(DOMAIN_DIR_MODE, 0o700);
  assert.ok(Number(PRIVATE_KEY_MODE) !== Number(CERT_FILE_MODE));
  assert.notEqual(fullchainPath("example.com"), privateKeyPath("example.com"));
  assert.ok(!challengeWebroot().includes(".."));
});
