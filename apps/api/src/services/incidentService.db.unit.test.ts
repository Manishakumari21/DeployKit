import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  acknowledgeIncident,
  detectGatewaySyncFailures,
  detectTlsFailures,
  detectWebhookFailures,
  getIncident,
  IncidentNotFoundError,
  IncidentStateError,
  listIncidents,
  persistCandidate,
  resolveIncident,
  runIncidentSweep,
  type IncidentCandidate,
} from "./incidentService.js";
import { gateDb } from "../test/dbGate.js";

const SUITE = "services/incidentService.db.unit.test.ts";
const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);

async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    const check = await pool.query(
      `SELECT to_regclass('public.incidents') AS c`
    );
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  return gateDb(SUITE, dbAvailable);
}

async function createProject(name: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO projects (name, repository_url, branch)
     VALUES ($1, 'https://github.com/acme/app.git', 'main')
     RETURNING id`,
    [name]
  );
  return result.rows[0].id as string;
}

async function createFailedDeployment(
  projectId: string,
  tag: string
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO deployments (project_id, status, trigger, branch, error_code, error_message)
     VALUES ($1, 'failed', 'manual', 'main', 'BUILD_FAILED', $2)
     RETURNING id`,
    [projectId, `build failed: ${tag}`]
  );
  return result.rows[0].id as string;
}

async function cleanup(projects: string[]): Promise<void> {
  if (projects.length === 0) return;
  await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [projects]);
}

function candidate(overrides: Partial<IncidentCandidate> & {
  projectId: string;
  subjectKey: string;
}): IncidentCandidate {
  return {
    kind: "deployment_failure",
    severity: "warning",
    title: "Deployment failed on main",
    detail: "build failed",
    errorCode: "BUILD_FAILED",
    evidence: { note: "fixture" },
    signalToken: `failed:${overrides.subjectKey}`,
    sourceTimestamp: new Date(),
    ...overrides,
  };
}

test("duplicate sweeps are idempotent and never double-count a signal", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-dup-${Date.now()}`);
  try {
    const deploymentId = await createFailedDeployment(projectId, "dup");
    const first = await runIncidentSweep();
    assert.ok(first.created >= 1, "the sweep creates an incident");

    const rows = async () =>
      pool.query(
        `SELECT id, occurrence_count, status FROM incidents
         WHERE project_id = $1 AND subject_key = $2`,
        [projectId, `deployment:${deploymentId}`]
      );

    const afterFirst = await rows();
    assert.equal(afterFirst.rowCount, 1, "one incident per subject");
    const initialCount = afterFirst.rows[0].occurrence_count as number;

    // Repeated sweeps with the identical signal must not bump the counter.
    await runIncidentSweep();
    await runIncidentSweep();
    const afterRepeat = await rows();
    assert.equal(afterRepeat.rowCount, 1);
    assert.equal(
      afterRepeat.rows[0].occurrence_count,
      initialCount,
      "identical signals never increment occurrence_count"
    );
  } finally {
    await cleanup([projectId]);
  }
});

test("a genuinely new signal counts exactly once even when the sweep retries", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-bump-${Date.now()}`);
  try {
    const subjectKey = `deployment:${await createFailedDeployment(projectId, "bump")}`;
    const base = candidate({ projectId, subjectKey, signalToken: "failed:v1" });
    const created = await persistCandidate(base);
    assert.equal(created.outcome, "created");

    const newSignal = { ...base, signalToken: "failed:v2", detail: "new error" };
    const bumped = await persistCandidate(newSignal);
    assert.equal(bumped.outcome, "updated", "a changed token is a new signal");
    assert.equal(
      (bumped as { incident: { occurrence_count: number } }).incident.occurrence_count,
      2
    );

    // Retrying the identical new signal must not count it a third time.
    const retried = await persistCandidate(newSignal);
    assert.equal(retried.outcome, "touched");
    assert.equal(
      (retried as { incident: { occurrence_count: number } }).incident.occurrence_count,
      2,
      "a retried sweep counts the new signal once"
    );
  } finally {
    await cleanup([projectId]);
  }
});

test("concurrent persistence of the same new subject creates one incident", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-race-${Date.now()}`);
  try {
    const subjectKey = `deployment:${await createFailedDeployment(projectId, "race")}`;
    const shared = candidate({ projectId, subjectKey, signalToken: "failed:race" });
    const results = await Promise.allSettled([
      persistCandidate(shared),
      persistCandidate(shared),
      persistCandidate(shared),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 3, "concurrent duplicates never error");

    const rows = await pool.query(
      `SELECT occurrence_count FROM incidents
       WHERE project_id = $1 AND subject_key = $2 AND status <> 'resolved'`,
      [projectId, subjectKey]
    );
    assert.equal(rows.rowCount, 1, "the partial unique index allows one open row");
    assert.equal(
      rows.rows[0].occurrence_count,
      1,
      "identical concurrent signals count once"
    );
  } finally {
    await cleanup([projectId]);
  }
});

test("manual resolution silences the same signal identity but not a new one", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-manual-${Date.now()}`);
  try {
    const subjectKey = `deployment:${await createFailedDeployment(projectId, "manual")}`;
    const base = candidate({
      projectId,
      subjectKey,
      signalToken: "failed:manual",
      sourceTimestamp: new Date(Date.now() - 60_000),
    });
    const created = await persistCandidate(base);
    assert.equal(created.outcome, "created");
    const incidentId = (created as { incident: { id: string } }).incident.id;

    const resolved = await resolveIncident({ projectId, incidentId });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "manual");

    // Same identity, newer timestamp: a manual resolution stays silenced.
    const sameIdentity = await persistCandidate({
      ...base,
      sourceTimestamp: new Date(),
    });
    assert.equal(sameIdentity.outcome, "skipped");

    // A different signal identity reopens as a NEW incident, keeping history.
    const newIdentity = await persistCandidate({
      ...base,
      signalToken: "failed:manual-v2",
      sourceTimestamp: new Date(),
      detail: "different failure",
    });
    assert.equal(newIdentity.outcome, "created");
    assert.notEqual(
      (newIdentity as { incident: { id: string } }).incident.id,
      incidentId,
      "recurrence is a new row, never a rewrite of resolved history"
    );

    const history = await pool.query(
      `SELECT status, resolution FROM incidents
       WHERE project_id = $1 AND subject_key = $2
       ORDER BY created_at ASC`,
      [projectId, subjectKey]
    );
    assert.equal(history.rowCount, 2, "resolved history is preserved");
    assert.equal(history.rows[0].status, "resolved");
    assert.equal(history.rows[0].resolution, "manual");
    assert.equal(history.rows[1].status, "open");
  } finally {
    await cleanup([projectId]);
  }
});

test("auto-resolve on verified recovery, then recurrence opens a fresh incident", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-auto-${Date.now()}`);
  try {
    const deploymentId = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch)
       VALUES ($1, 'active', 'manual', 'main') RETURNING id`,
      [projectId]
    ).then((r) => r.rows[0].id as string);
    const releaseId = await pool.query(
      `INSERT INTO releases (deployment_id, project_id, image_repository, image_digest, commit_sha, branch, status)
       VALUES ($1, $2, 'deploykit/app', $3, $4, 'main', 'active') RETURNING id`,
      [deploymentId, projectId, DIGEST, SHA]
    ).then((r) => r.rows[0].id as string);
    const runtimeId = await pool.query(
      `INSERT INTO runtime_instances (release_id, status, container_name, container_port, host_port,
                                      started_at, last_health_check_at, error_code, error_message)
       VALUES ($1, 'unhealthy', $2, 3000, 31009, now() - interval '10 minutes', now() - interval '2 minutes',
               'RUNTIME_CONTAINER_NOT_RUNNING', 'container not running')
       RETURNING id`,
      [releaseId, `dk-inc${Date.now() % 1000000}`]
    ).then((r) => r.rows[0].id as string);

    const first = await runIncidentSweep();
    assert.ok(first.created >= 1);
    const openBefore = await pool.query(
      `SELECT id, status, source_timestamp FROM incidents
       WHERE project_id = $1 AND subject_key = $2`,
      [projectId, `runtime:${runtimeId}`]
    );
    assert.equal(openBefore.rowCount, 1);
    assert.equal(openBefore.rows[0].status, "open");
    const originalId = openBefore.rows[0].id as string;

    // The monitor confirms recovery with a health check NEWER than the signal.
    await pool.query(
      `UPDATE runtime_instances
       SET status = 'running', error_code = NULL, error_message = NULL,
           last_health_check_at = now() + interval '1 minute'
       WHERE id = $1`,
      [runtimeId]
    );
    const recovered = await runIncidentSweep();
    assert.ok(recovered.resolved >= 1, "verified recovery auto-resolves");
    const afterRecovery = await pool.query(
      `SELECT status, resolution FROM incidents WHERE id = $1`,
      [originalId]
    );
    assert.equal(afterRecovery.rows[0].status, "resolved");
    assert.equal(afterRecovery.rows[0].resolution, "auto");

    // The runtime fails again AFTER the resolution: a fresh incident opens.
    await pool.query(
      `UPDATE runtime_instances
       SET status = 'unhealthy', error_code = 'RUNTIME_CONTAINER_NOT_RUNNING',
           error_message = 'container not running',
           last_health_check_at = now() + interval '5 minutes'
       WHERE id = $1`,
      [runtimeId]
    );
    await runIncidentSweep();
    const recurrent = await pool.query(
      `SELECT id, status, occurrence_count FROM incidents
       WHERE project_id = $1 AND subject_key = $2
       ORDER BY created_at ASC`,
      [projectId, `runtime:${runtimeId}`]
    );
    assert.equal(recurrent.rowCount, 2, "recurrence creates a new incident");
    assert.equal(recurrent.rows[0].id, originalId, "resolved history untouched");
    assert.equal(recurrent.rows[0].status, "resolved");
    assert.equal(recurrent.rows[1].status, "open");
    assert.equal(recurrent.rows[1].occurrence_count, 1);
  } finally {
    await cleanup([projectId]);
  }
});

test("evidence older than a resolution can never reopen the incident", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-stale-${Date.now()}`);
  try {
    const subjectKey = `gateway:${projectId}`;
    const oldTimestamp = new Date(Date.now() - 3 * 60_000);
    const created = await persistCandidate(
      candidate({
        projectId,
        subjectKey,
        kind: "gateway_sync_failed",
        signalToken: "gateway:stale",
        sourceTimestamp: oldTimestamp,
      })
    );
    assert.equal(created.outcome, "created");
    const incidentId = (created as { incident: { id: string } }).incident.id;

    await resolveIncident({ projectId, incidentId });

    // Replaying the pre-resolution evidence must stay skipped.
    const replay = await persistCandidate(
      candidate({
        projectId,
        subjectKey,
        kind: "gateway_sync_failed",
        signalToken: "gateway:stale",
        sourceTimestamp: oldTimestamp,
      })
    );
    assert.equal(replay.outcome, "skipped");
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM incidents WHERE project_id = $1`,
      [projectId]
    );
    assert.equal(rows.rows[0].n, 1, "no incident was reopened or duplicated");
  } finally {
    await cleanup([projectId]);
  }
});

test("concurrent acknowledge and resolve transitions are guarded", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-conc-${Date.now()}`);
  const createdUserIds: string[] = [];
  try {
    const created = await persistCandidate(
      candidate({ projectId, subjectKey: `deployment:${await createFailedDeployment(projectId, "conc")}` })
    );
    assert.equal(created.outcome, "created");
    const incidentId = (created as { incident: { id: string } }).incident.id;

    // acknowledged_by carries an FK to users(id), so the actor must exist.
    const actorId = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2) RETURNING id`,
      [
        `phase3-inc-actor-${Date.now()}@example.com`,
        "x".repeat(60),
      ]
    ).then((r) => r.rows[0].id as string);
    createdUserIds.push(actorId);
    const acks = await Promise.allSettled([
      acknowledgeIncident({ projectId, incidentId, userId: actorId }),
      acknowledgeIncident({ projectId, incidentId, userId: actorId }),
    ]);
    const winners = acks.filter((r) => r.status === "fulfilled");
    const losers = acks.filter((r) => r.status === "rejected");
    assert.equal(winners.length, 1, "exactly one acknowledge wins");
    assert.equal(losers.length, 1, "the duplicate is rejected");
    const loser = losers[0] as PromiseRejectedResult;
    assert.ok(
      loser.reason instanceof IncidentStateError,
      "the losing transition is an IncidentStateError (409 upstream)"
    );

    // Acknowledged incidents still resolve; a second resolve is a 409.
    await resolveIncident({ projectId, incidentId });
    await assert.rejects(
      resolveIncident({ projectId, incidentId }),
      IncidentStateError
    );
    await assert.rejects(
      acknowledgeIncident({ projectId, incidentId, userId: actorId }),
      IncidentStateError,
      "acknowledging a resolved incident is rejected"
    );
  } finally {
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]).catch(() => undefined);
    }
    await cleanup([projectId]);
  }
});

test("incidents are scoped to their project", async () => {
  if (!(await ready())) return;
  const projectA = await createProject(`inc-xA-${Date.now()}`);
  const projectB = await createProject(`inc-xB-${Date.now()}`);
  try {
    const created = await persistCandidate(
      candidate({ projectId: projectA, subjectKey: "deployment:scoped" })
    );
    assert.equal(created.outcome, "created");
    const incidentId = (created as { incident: { id: string } }).incident.id;

    const forA = await listIncidents({ projectId: projectA });
    const forB = await listIncidents({ projectId: projectB });
    assert.ok(forA.some((i) => i.id === incidentId));
    assert.ok(!forB.some((i) => i.id === incidentId), "cross-project list is empty");

    await assert.rejects(
      getIncident({ projectId: projectB, incidentId }),
      IncidentNotFoundError,
      "cross-project fetch is a not-found, never a leak"
    );
  } finally {
    await cleanup([projectA, projectB]);
  }
});

test("TLS expiry is detected as critical and recovers only on a valid issuance", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-tls-${Date.now()}`);
  try {
    const domainId = await pool.query(
      `INSERT INTO custom_domains (project_id, domain, status, verification_token_hash,
                                   verified_at, tls_status, cert_expires_at, tls_last_attempt_at)
       VALUES ($1, $2, 'verified', $3, now(), 'issued', now() - interval '1 hour', now() - interval '2 hours')
       RETURNING id`,
      [projectId, `inc-${Date.now()}.example.com`, "a".repeat(64)]
    ).then((r) => r.rows[0].id as string);

    const candidates = await detectTlsFailures();
    const mine = candidates.filter((c) => c.subjectKey === `tls:${domainId}`);
    assert.equal(mine.length, 1, "an expired certificate is a TLS failure");
    assert.equal(mine[0].severity, "critical");
    assert.equal(mine[0].errorCode, "TLS_CERT_EXPIRED");

    await persistCandidate(mine[0]);
    const openRow = await pool.query(
      `SELECT id FROM incidents WHERE project_id = $1 AND subject_key = $2`,
      [projectId, `tls:${domainId}`]
    );
    assert.equal(openRow.rowCount, 1);

    // Recovery requires the certificate to be ISSUED and still VALID.
    await pool.query(
      `UPDATE custom_domains
       SET tls_status = 'issued', cert_expires_at = now() + interval '90 days',
           tls_last_attempt_at = now() + interval '1 minute'
       WHERE id = $1`,
      [domainId]
    );
    const summary = await runIncidentSweep();
    assert.ok(summary.resolved >= 1);
    const after = await pool.query(
      `SELECT status, resolution FROM incidents WHERE id = $1`,
      [openRow.rows[0].id]
    );
    assert.equal(after.rows[0].status, "resolved");
    assert.equal(after.rows[0].resolution, "auto");

    // A half-issued state (pending) must NOT count as recovery.
    await pool.query(
      `UPDATE custom_domains SET tls_status = 'failed', tls_last_error_code = 'TLS_DNS_TIMEOUT',
              tls_last_attempt_at = now() + interval '3 minutes'
       WHERE id = $1`,
      [domainId]
    );
    await runIncidentSweep();
    const reopened = await pool.query(
      `SELECT status FROM incidents
       WHERE project_id = $1 AND subject_key = $2 AND status <> 'resolved'`,
      [projectId, `tls:${domainId}`]
    );
    assert.equal(reopened.rowCount, 1, "a new TLS failure reopens as a new incident");
  } finally {
    await cleanup([projectId]);
  }
});

test("webhook incidents attribute only to reliably identified projects", async () => {
  if (!(await ready())) return;
  const attributed = await createProject(`inc-hook-a-${Date.now()}`);
  const linkedOnly = await createProject(`inc-hook-b-${Date.now()}`);
  const ambiguousA = await createProject(`inc-hook-c1-${Date.now()}`);
  const ambiguousB = await createProject(`inc-hook-c2-${Date.now()}`);
  const deliveries: string[] = [];
  const repos: string[] = [];
  try {
    const deploymentId = await pool.query(
      `INSERT INTO deployments (project_id, status, trigger, branch)
       VALUES ($1, 'failed', 'github_push', 'main') RETURNING id`,
      [attributed]
    ).then((r) => r.rows[0].id as string);

    // A repository linked to exactly ONE project is attributable.
    const linkedRepo = await pool.query(
      `INSERT INTO github_repositories (full_name) VALUES ('acme/linked-only') RETURNING id`
    ).then((r) => r.rows[0].id as string);
    repos.push(linkedRepo);
    await pool.query(`UPDATE projects SET github_repository_id = $1 WHERE id = $2`, [
      linkedRepo,
      linkedOnly,
    ]);

    // A repository linked to TWO projects is ambiguous and must be skipped.
    const sharedRepo = await pool.query(
      `INSERT INTO github_repositories (full_name) VALUES ('acme/shared') RETURNING id`
    ).then((r) => r.rows[0].id as string);
    repos.push(sharedRepo);
    await pool.query(
      `UPDATE projects SET github_repository_id = $1 WHERE id = ANY($2)`,
      [sharedRepo, [ambiguousA, ambiguousB]]
    );

    const mk = (id: string, extra: Record<string, unknown> = {}) =>
      pool.query(
        `INSERT INTO github_webhook_deliveries (delivery_id, event_type, status, repository_full_name, error, updated_at, attempts)
         VALUES ($1, 'push', 'failed', $2, 'handler threw', now(), 1)
         RETURNING delivery_id`,
        [id, extra.repository ?? null]
      ).then((r) => {
        deliveries.push(r.rows[0].delivery_id as string);
        return r.rows[0].delivery_id as string;
      });

    const viaDeployment = await mk(`dk-inc-dep-${Date.now()}`);
    await pool.query(
      `UPDATE github_webhook_deliveries SET deployment_id = $1 WHERE delivery_id = $2`,
      [deploymentId, viaDeployment]
    );
    const viaRepo = await mk(`dk-inc-repo-${Date.now()}`, { repository: "acme/linked-only" });
    const ambiguous = await mk(`dk-inc-amb-${Date.now()}`, { repository: "acme/shared" });
    const unlinked = await mk(`dk-inc-none-${Date.now()}`, { repository: "acme/unknown" });

    const candidates = await detectWebhookFailures();
    const keys = new Set(candidates.map((c) => c.subjectKey));
    assert.ok(keys.has(`webhook:${viaDeployment}`), "deployment-linked delivery is attributed");
    assert.ok(keys.has(`webhook:${viaRepo}`), "single-project repository is attributed");
    assert.ok(!keys.has(`webhook:${ambiguous}`), "ambiguous repository is skipped");
    assert.ok(!keys.has(`webhook:${unlinked}`), "unlinked repository is skipped");

    const depCandidate = candidates.find((c) => c.subjectKey === `webhook:${viaDeployment}`);
    assert.equal(depCandidate?.projectId, attributed);
    const repoCandidate = candidates.find((c) => c.subjectKey === `webhook:${viaRepo}`);
    assert.equal(repoCandidate?.projectId, linkedOnly);
  } finally {
    await pool.query(
      `UPDATE projects SET github_repository_id = NULL WHERE id = ANY($1)`,
      [[attributed, linkedOnly, ambiguousA, ambiguousB]]
    );
    await cleanup([attributed, linkedOnly, ambiguousA, ambiguousB]);
    if (repos.length > 0) {
      await pool.query(`DELETE FROM github_repositories WHERE id = ANY($1)`, [repos]);
    }
    if (deliveries.length > 0) {
      await pool.query(`DELETE FROM github_webhook_deliveries WHERE delivery_id = ANY($1)`, [
        deliveries,
      ]);
    }
  }
});

test("gateway sync recovery requires a newer success with no current failure", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-gw-${Date.now()}`);
  try {
    await pool.query(
      `INSERT INTO gateway_sync_requests (project_id, reason, status, attempts, last_error, updated_at)
       VALUES ($1, 'deployment.promoted', 'failed', 5, 'gateway refused config', now() - interval '5 minutes')`,
      [projectId]
    );
    const failing = await detectGatewaySyncFailures();
    const mine = failing.filter((c) => c.projectId === projectId);
    assert.equal(mine.length, 1, "the newest failed request is detected");
    await persistCandidate(mine[0]);

    // A newer SUCCESS request without any current failure is verified recovery.
    await pool.query(
      `INSERT INTO gateway_sync_requests (project_id, reason, status, attempts, updated_at)
       VALUES ($1, 'deployment.promoted', 'done', 6, now())`,
      [projectId]
    );
    const summary = await runIncidentSweep();
    assert.ok(summary.resolved >= 1);
    const row = await pool.query(
      `SELECT status, resolution FROM incidents
       WHERE project_id = $1 AND subject_key = $2`,
      [projectId, `gateway:${projectId}`]
    );
    assert.equal(row.rows[0].status, "resolved");
    assert.equal(row.rows[0].resolution, "auto");
  } finally {
    await cleanup([projectId]);
  }
});

test("deployment failures never auto-resolve, even after the source is gone", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-dep-${Date.now()}`);
  try {
    const deploymentId = await createFailedDeployment(projectId, "noauto");
    await runIncidentSweep();
    const row = await pool.query(
      `SELECT id, status FROM incidents
       WHERE project_id = $1 AND subject_key = $2`,
      [projectId, `deployment:${deploymentId}`]
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].status, "open");

    // A failed deployment is terminal: no recovery predicate exists, so the
    // incident stays open until a human resolves it.
    await runIncidentSweep();
    const still = await pool.query(
      `SELECT status FROM incidents WHERE id = $1`,
      [row.rows[0].id]
    );
    assert.equal(still.rows[0].status, "open", "deployment failures are manual-only");
  } finally {
    await cleanup([projectId]);
  }
});

test("list supports status and kind filters with bounded limits", async () => {
  if (!(await ready())) return;
  const projectId = await createProject(`inc-list-${Date.now()}`);
  try {
    await persistCandidate(
      candidate({ projectId, subjectKey: "deployment:list-1", signalToken: "l1" })
    );
    await persistCandidate(
      candidate({
        projectId,
        subjectKey: "gateway:list-2",
        kind: "gateway_sync_failed",
        signalToken: "l2",
      })
    );

    const active = await listIncidents({ projectId, status: "active" });
    assert.equal(active.length, 2);

    const onlyGateway = await listIncidents({ projectId, kind: "gateway_sync_failed" });
    assert.equal(onlyGateway.length, 1);
    assert.equal(onlyGateway[0].kind, "gateway_sync_failed");

    const bounded = await listIncidents({ projectId, limit: 1 });
    assert.equal(bounded.length, 1, "limit is honored");

    const resolved = await listIncidents({ projectId, status: "resolved" });
    assert.equal(resolved.length, 0);
  } finally {
    await cleanup([projectId]);
  }
});
