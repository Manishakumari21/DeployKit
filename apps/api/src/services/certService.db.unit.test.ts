// Phase 11.6: certificate state machine over real PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import { createProject } from "./projectService.js";
import { createUser } from "./userService.js";
import {
  createDomain,
  deleteDomainRow,
  getDomainById,
  verifyDomain,
} from "./domainService.js";
import {
  CertError,
  claimDueCertificates,
  countRenewalDue,
  markCertificateFailed,
  markCertificateIssued,
  markExpiredCertificates,
  requestCertificate,
} from "./certService.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(
      `SELECT to_regclass('public.custom_domains') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueDomain(tag: string): string {
  return `phase11-tls-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example.org`;
}

const userIds: string[] = [];
const projectIds: string[] = [];

async function makeVerifiedDomain(tag: string): Promise<{ projectId: string; domainId: string; token: string }> {
  const user = await createUser({
    email: `phase11-tls-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
    password: "correct-horse-123",
  });
  userIds.push(user.id);
  const project = await createProject({
    name: `tls-${tag}-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: user.id,
  });
  projectIds.push(project.id);
  const created = await createDomain({ projectId: project.id, domain: uniqueDomain(tag) });
  const verified = await verifyDomain(created.row.id, {
    lookupTxt: async () => [[created.verificationToken]],
  });
  assert.equal(verified.row.status, "verified");
  return { projectId: project.id, domainId: created.row.id, token: created.verificationToken };
}

async function teardown(): Promise<void> {
  if (projectIds.length > 0) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projectIds]);
    projectIds.length = 0;
  }
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    userIds.length = 0;
  }
}

test("request arms pending, rejects unverified, refuses duplicate work", async () => {
  if (!(await dbAvailable())) return;
  try {
    const { domainId } = await makeVerifiedDomain("req");
    const armed = await requestCertificate(domainId);
    assert.equal(armed.tls_status, "pending");
    assert.ok(armed.tls_requested_at);
    await assert.rejects(requestCertificate(domainId), (e: unknown) => {
      return e instanceof CertError && e.code === "CERT_REQUEST_ACTIVE";
    });
    // Unverified domains cannot start ACME.
    const other = await makeVerifiedDomain("other");
    await pool.query(`UPDATE custom_domains SET status = 'pending' WHERE id = $1`, [other.domainId]);
    await assert.rejects(requestCertificate(other.domainId), (e: unknown) => {
      return e instanceof CertError && e.code === "DOMAIN_UNVERIFIED";
    });
  } finally {
    await teardown();
  }
});

test("issued rows near expiry are claimed and moved to renewing", async () => {
  if (!(await dbAvailable())) return;
  try {
    const soon = await makeVerifiedDomain("soon");
    const later = await makeVerifiedDomain("later");
    await pool.query(
      `UPDATE custom_domains SET tls_status = 'issued', cert_expires_at = NOW() + make_interval(secs => $2) WHERE id = $1`,
      [soon.domainId, 29 * 24 * 3600]
    );
    await pool.query(
      `UPDATE custom_domains SET tls_status = 'issued', cert_expires_at = NOW() + make_interval(secs => $2) WHERE id = $1`,
      [later.domainId, 31 * 24 * 3600]
    );
    assert.equal(await countRenewalDue() >= 1, true);
    const claimed = await claimDueCertificates(10);
    const ids = claimed.map((r) => r.id);
    assert.ok(ids.includes(soon.domainId));
    assert.ok(!ids.includes(later.domainId));
    assert.equal((await getDomainById(soon.domainId))?.tls_status, "renewing");
  } finally {
    await teardown();
  }
});

test("concurrent renewal claims serialize to a single winner", async () => {
  if (!(await dbAvailable())) return;
  try {
    const { domainId } = await makeVerifiedDomain("race");
    await pool.query(
      `UPDATE custom_domains SET tls_status = 'issued', cert_expires_at = NOW() + make_interval(secs => 3600) WHERE id = $1`,
      [domainId]
    );
    const [first, second] = await Promise.all([
      claimDueCertificates(10),
      claimDueCertificates(10),
    ]);
    const total = [...first, ...second].filter((r) => r.id === domainId).length;
    assert.equal(total, 1);
  } finally {
    await teardown();
  }
});

test("issued marking is compare-and-set; failures revert or record", async () => {
  if (!(await dbAvailable())) return;
  try {
    const { domainId } = await makeVerifiedDomain("mark");
    await requestCertificate(domainId);
    await assert.rejects(
      markCertificateIssued({
        domainId,
        expectedTls: ["renewing"],
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
        certPath: "domains/x",
      }),
      (e: unknown) => e instanceof CertError
    );
    const issued = await markCertificateIssued({
      domainId,
      expectedTls: ["pending"],
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      certPath: "domains/x",
    });
    assert.equal(issued.tls_status, "issued");
    assert.ok(issued.cert_expires_at);
    // Renewal failure with a valid cert reverts to issued with error kept.
    const reverted = await markCertificateFailed({
      domainId,
      code: "ACME_REQUEST_FAILED",
      message: "boom",
      revertToIssued: true,
    });
    assert.equal(reverted.tls_status, "issued");
    assert.equal(reverted.tls_last_error_code, "ACME_REQUEST_FAILED");
    // First-issuance failure records failed.
    const { domainId: second } = await makeVerifiedDomain("mark2");
    await requestCertificate(second);
    const failed = await markCertificateFailed({
      domainId: second,
      code: "ACME_REQUEST_FAILED",
      message: "boom",
      revertToIssued: false,
    });
    assert.equal(failed.tls_status, "failed");
  } finally {
    await teardown();
  }
});

test("expiry sweeper marks projects and deletion removes TLS metadata", async () => {
  if (!(await dbAvailable())) return;
  try {
    const { domainId, projectId } = await makeVerifiedDomain("exp");
    await pool.query(
      `UPDATE custom_domains SET tls_status = 'issued', cert_expires_at = NOW() - make_interval(secs => 60) WHERE id = $1`,
      [domainId]
    );
    const affected = await markExpiredCertificates();
    assert.ok(affected.includes(projectId));
    assert.equal((await getDomainById(domainId))?.tls_status, "expired");
    const deleted = await deleteDomainRow(domainId);
    assert.ok(deleted);
    assert.equal(await getDomainById(domainId), null);
    const idx = (
      await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'custom_domains'`)
    ).rows.map((r: { indexname: string }) => r.indexname);
    assert.ok(idx.includes("custom_domains_tls_pending_idx"));
    assert.ok(idx.includes("custom_domains_tls_expiry_idx"));
  } finally {
    await teardown();
  }
});
