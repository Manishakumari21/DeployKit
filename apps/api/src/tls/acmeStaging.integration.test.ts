// Phase 11.8 REAL ACME staging path (opt-in, never part of normal tests).
// Requires a publicly reachable host with DNS pointed at it plus:
//   DEPLOYKIT_TEST_ACME_DOMAIN=<real domain>
//   DEPLOYKIT_TEST_ACME_EMAIL=<valid email>
//   lego binary installed (worker image or DEPLOYKIT_LEGO_BINARY)
// Without all three this test reports a skip and passes. It targets the
// staging CA only — production issuance is never attempted here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ACME_STAGING_URL,
  getAcmeConfig,
  LegoAcmeClient,
} from "./acmeClient.js";
import { certificateCoversDomain } from "./certValidation.js";

async function stagingPrereqs(): Promise<{ domain: string } | null> {
  const domain = (process.env.DEPLOYKIT_TEST_ACME_DOMAIN ?? "").trim();
  if (!domain) {
    console.log("acme staging test skipped: set DEPLOYKIT_TEST_ACME_DOMAIN to enable");
    return null;
  }
  if (!process.env.DEPLOYKIT_ACME_EMAIL) {
    console.log("acme staging test skipped: set DEPLOYKIT_ACME_EMAIL to enable");
    return null;
  }
  try {
    const { runCommand } = await import("../infrastructure/process/dockerExec.js");
    const binary = (process.env.DEPLOYKIT_LEGO_BINARY ?? "lego").trim() || "lego";
    const check = await runCommand(binary, ["--version"], 15_000);
    if (check.code !== 0) {
      console.log("acme staging test skipped: lego binary unavailable");
      return null;
    }
  } catch {
    console.log("acme staging test skipped: lego binary unavailable");
    return null;
  }
  return { domain };
}

test(
  "staging ACME issues a hostname-valid certificate over HTTP-01",
  { timeout: 300_000 },
  async () => {
    const ready = await stagingPrereqs();
    if (!ready) return;
    const work = await mkdtemp(path.join(os.tmpdir(), "deploykit-acme-staging-"));
    try {
      const config = getAcmeConfig({
        serverUrl: ACME_STAGING_URL,
        legoPath: path.join(work, "acme"),
        webroot: path.join(work, "challenges"),
      });
      const client = new LegoAcmeClient(config);
      const result = await client.requestCertificate(ready.domain);
      assert.ok(certificateCoversDomain(result.certificatePem, ready.domain));
      assert.ok(result.expiresAt > new Date());
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
);
