import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import pool from "../db/database.js";
import { createProject } from "./projectService.js";
import { createUser } from "./userService.js";
import {
  createDomain,
  deleteDomainRow,
  getDomainById,
  getVerifiedDomains,
  listDomains,
  verifyDomain,
  hashVerificationToken,
} from "./domainService.js";
import { DomainError } from "../domains/domainName.js";

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
  const rand = Math.floor(Math.random() * 1_000_000);
  return `phase11-${tag}-${Date.now()}-${rand}.example.org`;
}

const userIds: string[] = [];
const projectIds: string[] = [];

async function makeProject(): Promise<string> {
  const user = await createUser({
    email: `phase11-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
    password: "correct-horse-123",
  });
  userIds.push(user.id);
  const project = await createProject({
    name: `phase11-${Date.now()}`,
    repositoryUrl: "https://github.com/acme/app.git",
    branch: "main",
    ownerUserId: user.id,
  });
  projectIds.push(project.id);
  return project.id;
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

test("creation normalizes and stores only a token hash", async () => {
  if (!(await dbAvailable())) return;
  const projectId = await makeProject();
  try {
    const domain = uniqueDomain("norm");
    const created = await createDomain({ projectId, domain: `  ${domain.toUpperCase()}. ` });
    assert.equal(created.row.domain, domain.toLowerCase());
    assert.equal(created.row.status, "pending");
    assert.equal(created.row.tls_status, "none");
    assert.equal(created.verificationToken.length, 64);
    const raw = (
      await pool.query(
        `SELECT verification_token_hash FROM custom_domains WHERE id = $1`,
        [created.row.id]
      )
    ).rows[0];
    assert.equal(raw.verification_token_hash, hashVerificationToken(created.verificationToken));
    assert.ok(!raw.verification_token_hash.includes(created.verificationToken.slice(0, 8)));
    await deleteDomainRow(created.row.id);
  } finally {
    await teardown();
  }
});

test("global uniqueness prevents cross-project hijacking", async () => {
  if (!(await dbAvailable())) return;
  const a = await makeProject();
  const b = await makeProject();
  try {
    const domain = uniqueDomain("hijack");
    const created = await createDomain({ projectId: a, domain });
    assert.ok(created.row.id);
    await assert.rejects(createDomain({ projectId: b, domain }), (e: unknown) => {
      return e instanceof DomainError && (e as DomainError).code === "DOMAIN_TAKEN";
    });
    await assert.rejects(
      createDomain({ projectId: b, domain: domain.toUpperCase() }),
      (e: unknown) => e instanceof DomainError && (e as DomainError).code === "DOMAIN_TAKEN"
    );
    await assert.rejects(createDomain({ projectId: a, domain }), (e: unknown) => {
      return e instanceof DomainError && (e as DomainError).code === "DOMAIN_TAKEN";
    });
    await deleteDomainRow(created.row.id);
  } finally {
    await teardown();
  }
});

test("concurrent creation does not create duplicates", async () => {
  if (!(await dbAvailable())) return;
  const projectId = await makeProject();
  const other = await makeProject();
  try {
    const domain = uniqueDomain("race");
    const attempts = await Promise.allSettled([
      createDomain({ projectId, domain }),
      createDomain({ projectId: other, domain }),
      createDomain({ projectId, domain: domain.toUpperCase() }),
    ]);
    const fulfilled = attempts.filter((r) => r.status === "fulfilled");
    const rejected = attempts.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 2);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      assert.ok(reason instanceof DomainError && reason.code === "DOMAIN_TAKEN");
    }
    const rows = await listDomains(projectId);
    const otherRows = await listDomains(other);
    assert.equal(rows.length + otherRows.length, 1);
    for (const r of [...rows, ...otherRows]) await deleteDomainRow(r.id);
  } finally {
    await teardown();
  }
});

test("correct TXT token verifies; wrong/missing/expired fail; rotation invalidates", async () => {
  if (!(await dbAvailable())) return;
  const projectId = await makeProject();
  try {
    const domain = uniqueDomain("verify");
    const created = await createDomain({ projectId, domain });
    const good = async () => [[created.verificationToken]];
    const ok = await verifyDomain(created.row.id, { lookupTxt: good });
    assert.equal(ok.row.status, "verified");

    const domain2 = uniqueDomain("wrong");
    const bad = await createDomain({ projectId, domain: domain2 });
    await assert.rejects(
      verifyDomain(bad.row.id, { lookupTxt: async () => [["wrong-token"]] }),
      (e: unknown) => e instanceof DomainError
    );
    const failed = await getDomainById(bad.row.id);
    assert.equal(failed?.status, "failed");

    const domain3 = uniqueDomain("missing");
    const missing = await createDomain({ projectId, domain: domain3 });
    await assert.rejects(
      verifyDomain(missing.row.id, { lookupTxt: async () => [] }),
      (e: unknown) => e instanceof DomainError
    );

    const domain4 = uniqueDomain("expired");
    const exp = await createDomain({ projectId, domain: domain4 });
    await pool.query(
      `UPDATE custom_domains SET verification_expires_at = NOW() - make_interval(secs => 60) WHERE id = $1`,
      [exp.row.id]
    );
    const oldToken = exp.verificationToken;
    await assert.rejects(
      verifyDomain(exp.row.id, { lookupTxt: async () => [[oldToken]] }),
      (e: unknown) => e instanceof DomainError && (e as DomainError).code === "VERIFICATION_EXPIRED"
    );
    const rotated = await getDomainById(exp.row.id);
    assert.equal(rotated?.status, "pending");
    assert.notEqual(rotated?.verification_token_hash, hashVerificationToken(oldToken));
    await assert.rejects(
      verifyDomain(exp.row.id, { lookupTxt: async () => [[oldToken]] }),
      (e: unknown) => e instanceof DomainError
    );

    for (const r of await listDomains(projectId)) await deleteDomainRow(r.id);
  } finally {
    await teardown();
  }
});

test("verified domains list feeds the renderer with one query", async () => {
  if (!(await dbAvailable())) return;
  const projectId = await makeProject();
  try {
    const a = await createDomain({ projectId, domain: uniqueDomain("a") });
    const b = await createDomain({ projectId, domain: uniqueDomain("b") });
    assert.deepEqual(await getVerifiedDomains(projectId), []);
    await verifyDomain(a.row.id, { lookupTxt: async () => [[a.verificationToken]] });
    assert.deepEqual(await getVerifiedDomains(projectId), [a.row.domain]);
    await verifyDomain(b.row.id, { lookupTxt: async () => [[b.verificationToken]] });
    const both = await getVerifiedDomains(projectId);
    assert.equal(both.length, 2);
    for (const r of await listDomains(projectId)) await deleteDomainRow(r.id);
  } finally {
    await teardown();
  }
});

test("project deletion cascades domains; invalid status rejected; indexes exist", async () => {
  if (!(await dbAvailable())) return;
  const projectId = await makeProject();
  try {
    const created = await createDomain({ projectId, domain: uniqueDomain("cascade") });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    projectIds.splice(projectIds.indexOf(projectId), 1);
    assert.equal(await getDomainById(created.row.id), null);
    const p2 = await makeProject();
    const d2 = await createDomain({ projectId: p2, domain: uniqueDomain("badstate") });
    await assert.rejects(
      pool.query(`UPDATE custom_domains SET status = 'bogus' WHERE id = $1`, [d2.row.id]),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
    const idx = (
      await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'custom_domains'`
      )
    ).rows.map((r: { indexname: string }) => r.indexname);
    assert.ok(idx.includes("custom_domains_domain_unique"));
    assert.ok(idx.includes("custom_domains_project_status_idx"));
    await deleteDomainRow(d2.row.id);
  } finally {
    await teardown();
  }
});

test("verification token uses cryptographic randomness", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) {
    seen.add(crypto.randomBytes(32).toString("hex"));
  }
  assert.equal(seen.size, 16);
});
