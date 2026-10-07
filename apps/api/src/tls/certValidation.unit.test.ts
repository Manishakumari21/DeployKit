// Phase 11.8: certificate validation against real openssl-generated
// certificates (skipped only when openssl is unavailable).
import test from "node:test";
import assert from "node:assert/strict";
import { SelfSignedAcmeClient } from "./acmeClient.js";
import {
  certificateCoversDomain,
  certificateExpiry,
  parseCertificate,
  validateCertificateForDomain,
  CertValidationError,
} from "./certValidation.js";

async function opensslAvailable(): Promise<boolean> {
  try {
    const { runCommand } = await import("../infrastructure/process/dockerExec.js");
    const result = await runCommand("openssl", ["version"], 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}

test("self-signed certificates parse with exact SAN coverage", async () => {
  if (!(await opensslAvailable())) return;
  const client = new SelfSignedAcmeClient("openssl", 90);
  const { certificatePem } = await client.requestCertificate("Example.COM");
  const parsed = parseCertificate(certificatePem);
  assert.ok(parsed.dnsNames.includes("example.com"));
  assert.ok(parsed.expiresAt > new Date(Date.now() + 80 * 24 * 3600 * 1000));
  assert.ok(parsed.fingerprint256.length > 0);
  assert.equal(certificateCoversDomain(certificatePem, "example.com"), true);
  assert.equal(certificateCoversDomain(certificatePem, "other.example.com"), false);
  assert.ok(certificateExpiry(certificatePem) > new Date());
  assert.doesNotThrow(() => validateCertificateForDomain(certificatePem, "example.com"));
});

test("wrong-domain, expired, and malformed certificates are rejected", async () => {
  if (!(await opensslAvailable())) return;
  const client = new SelfSignedAcmeClient("openssl", 90);
  const { certificatePem } = await client.requestCertificate("a.example.com");
  assert.throws(
    () => validateCertificateForDomain(certificatePem, "b.example.com"),
    (e: unknown) => e instanceof CertValidationError
  );
  const expired = new SelfSignedAcmeClient("openssl", 90);
  const old = await expired.requestCertificate("a.example.com");
  // A 90-day certificate validated a year from now is expired.
  assert.throws(
    () =>
      validateCertificateForDomain(
        old.certificatePem,
        "a.example.com",
        new Date(Date.now() + 366 * 24 * 3600 * 1000)
      ),
    (e: unknown) => e instanceof CertValidationError
  );
  assert.throws(() => parseCertificate("not-a-pem"), (e: unknown) => {
    return e instanceof CertValidationError;
  });
  // Wildcard SANs never satisfy exact coverage.
  const { runCommand } = await import("../infrastructure/process/dockerExec.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = await mkdtemp(join(tmpdir(), "deploykit-wild-"));
  try {
    const gen = await runCommand("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", join(work, "k.pem"),
      "-out", join(work, "c.pem"),
      "-days", "30", "-nodes",
      "-subj", "/CN=example.com",
      "-addext", "subjectAltName=DNS:*.example.com",
    ], 60_000);
    if (gen.code !== 0) return;
    const pem = await readFile(join(work, "c.pem"), "utf8");
    assert.equal(certificateCoversDomain(pem, "www.example.com"), false);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
});
