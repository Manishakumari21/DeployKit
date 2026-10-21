import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DB_GATED_SUITES: readonly string[] = [
  "agents/agentAuthentication.unit.test.ts",
  "agents/agentJobs.db.unit.test.ts",
  "agents/agentService.db.unit.test.ts",
  "agents/edgeAgentClient.integration.test.ts",
  "deployments/deploymentEvents.db.unit.test.ts",
  "services/authentication.db.unit.test.ts",
  "services/authorizationService.db.unit.test.ts",
  "services/certIssuance.db.unit.test.ts",
  "services/certService.db.unit.test.ts",
  "services/deploymentConcurrency.db.unit.test.ts",
  "services/deploymentLogService.db.unit.test.ts",
  "services/domainAuth.db.unit.test.ts",
  "services/domainE2E.db.unit.test.ts",
  "services/domainService.db.unit.test.ts",
  "services/gatewayActivation.db.unit.test.ts",
  "services/gatewayReconcile.db.unit.test.ts",
  "services/metricsService.db.unit.test.ts",
  "services/projectMembership.db.unit.test.ts",
  "services/registrationRace.db.unit.test.ts",
  "services/releaseService.db.unit.test.ts",
  "services/security.db.unit.test.ts",
  "services/sessionService.db.unit.test.ts",
  "services/userService.db.unit.test.ts",
  "services/webhookService.db.unit.test.ts",
  "services/webhookService.recovery.db.unit.test.ts",
  "workers/deploymentPipeline.db.unit.test.ts",
  "workers/deploymentPreflight.db.unit.test.ts",
  "workers/deploymentQueue.db.unit.test.ts",
  "workers/deploymentRetry.db.unit.test.ts",
  "workers/edgeBuild.db.unit.test.ts",
  "workers/pipelineZeroDowntime.db.unit.test.ts",
  "workers/runtimeHealthMonitor.db.unit.test.ts",
  "workers/workerCrashRecovery.db.unit.test.ts",
];

export type GateScope = "unit" | "integration" | "all";

export function gatedSuitesForScope(
  scope: GateScope = "all",
  suites: readonly string[] = DB_GATED_SUITES
): string[] {
  if (scope === "all") return [...suites];
  const suffix = scope === "unit" ? ".unit.test.ts" : ".integration.test.ts";
  return suites.filter((suite) => suite.endsWith(suffix));
}

export function isRequireDb(): boolean {
  return process.env.REQUIRE_DB === "1";
}

export function gateDir(): string | null {
  const dir = process.env.DB_GATE_DIR;
  return dir !== undefined && dir !== "" ? dir : null;
}

function markerPath(dir: string, suite: string): string {
  return path.join(dir, `${suite.replace(/\//g, "__")}.json`);
}

export function markDbSuite(suite: string, executed: boolean): void {
  const dir = gateDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      markerPath(dir, suite),
      JSON.stringify({ suite, executed, at: new Date().toISOString() })
    );
  } catch {

  }
}

export async function gateDb(
  suite: string,
  check: () => Promise<boolean>
): Promise<boolean> {
  let ok = false;
  try {
    ok = await check();
  } catch {
    ok = false;
  }
  if (!ok && isRequireDb()) {
    throw new Error(
      `REQUIRE_DB=1 but the database is unavailable for suite ${suite}; ` +
        `start PostgreSQL and set DATABASE_URL`
    );
  }
  markDbSuite(suite, ok);
  return ok;
}

export function missingExecutedSuites(
  dir: string,
  suites: readonly string[] = DB_GATED_SUITES
): string[] {
  const missing: string[] = [];
  for (const suite of suites) {
    let executed = false;
    try {
      if (existsSync(markerPath(dir, suite))) {
        const raw = readFileSync(markerPath(dir, suite), "utf8");
        executed = (JSON.parse(raw) as { executed?: unknown }).executed === true;
      }
    } catch {
      executed = false;
    }
    if (!executed) missing.push(suite);
  }
  return missing;
}
