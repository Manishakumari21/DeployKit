import { mkdir, readFile, rename, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import pool from "../db/database.js";
import type { TrafficRouter } from "../infrastructure/gateway/trafficRouter.js";
import { NginxGatewayRouter } from "../infrastructure/gateway/nginxGatewayRouter.js";
import {
  CERT_FILE_MODE,
  CHALLENGE_DIR_MODE,
  DOMAIN_DIR_MODE,
  PRIVATE_KEY_MODE,
  certPathRef,
  certsDir,
  challengeDir,
  domainCertDir,
  fullchainPath,
  privateKeyPath,
} from "../tls/certPaths.js";
import {
  validateCertificateForDomain,
  type ParsedCertificate,
} from "../tls/certValidation.js";
import {
  AcmeError,
  type AcmeClient,
} from "../tls/acmeClient.js";
import {
  claimDueCertificates,
  markCertificateFailed,
  markCertificateIssued,
  markExpiredCertificates,
} from "./certService.js";
import {
  getDomainById,
  type DomainRow,
} from "./domainService.js";
import {
  resolveActiveRoute,
  syncProjectTarget,
} from "./gatewayService.js";

export interface IssuanceDeps {
  acmeClient: AcmeClient;
  router?: TrafficRouter;
  certsRoot?: string;
  httpsVerifyTimeoutMs?: number;
  maxClaimsPerSweep?: number;
}

function tlsLog(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields }));
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    const content = await readFile(file, "utf8");
    return content.length > 128 * 1024 ? null : content;
  } catch {
    return null;
  }
}

async function previousIsValid(domain: string, root: string): Promise<boolean> {
  const pem = await readIfExists(fullchainPath(domain, root));
  if (!pem) return false;
  try {
    validateCertificateForDomain(pem, domain);
    return true;
  } catch {
    return false;
  }
}

async function installAtomically(
  domain: string,
  root: string,
  fullchainPem: string,
  privateKeyPem: string
): Promise<{ previousCert: string | null; previousKey: string | null }> {
  const dir = domainCertDir(domain, root);
  const certFile = fullchainPath(domain, root);
  const keyFile = privateKeyPath(domain, root);
  await mkdir(dir, { recursive: true, mode: DOMAIN_DIR_MODE });
  await mkdir(challengeDir(root), { recursive: true, mode: CHALLENGE_DIR_MODE });
  const previousCert = await readIfExists(certFile);
  const previousKey = await readIfExists(keyFile);
  const tmpCert = `${certFile}.tmp`;
  const tmpKey = `${keyFile}.tmp`;
  try {
    await writeFile(tmpCert, fullchainPem, { mode: CERT_FILE_MODE });
    await writeFile(tmpKey, privateKeyPem, { mode: PRIVATE_KEY_MODE });
    await rename(tmpCert, certFile);
    await rename(tmpKey, keyFile);
  } catch (error) {
    await rm(tmpCert, { force: true }).catch(() => undefined);
    await rm(tmpKey, { force: true }).catch(() => undefined);
    throw error;
  }
  return { previousCert, previousKey };
}

async function restorePrevious(
  domain: string,
  root: string,
  previous: { previousCert: string | null; previousKey: string | null }
): Promise<void> {
  const certFile = fullchainPath(domain, root);
  const keyFile = privateKeyPath(domain, root);
  if (previous.previousCert === null || previous.previousKey === null) {
    await rm(certFile, { force: true }).catch(() => undefined);
    await rm(keyFile, { force: true }).catch(() => undefined);
    return;
  }
  const tmpCert = `${certFile}.tmp`;
  const tmpKey = `${keyFile}.tmp`;
  await writeFile(tmpCert, previous.previousCert, { mode: CERT_FILE_MODE });
  await writeFile(tmpKey, previous.previousKey, { mode: PRIVATE_KEY_MODE });
  await rename(tmpCert, certFile);
  await rename(tmpKey, keyFile);
}

export async function processCertificateClaim(
  row: DomainRow,
  deps: IssuanceDeps
): Promise<DomainRow> {
  const root = deps.certsRoot ?? certsDir();
  const fresh = await getDomainById(row.id);
  if (!fresh || fresh.status !== "verified") {
    throw new AcmeError("CERT_STATE_CONFLICT", "Domain is no longer verified");
  }
  if (fresh.tls_status !== "pending" && fresh.tls_status !== "renewing") {
    throw new AcmeError("CERT_STATE_CONFLICT", "Certificate is no longer due");
  }
  const wasRenewal = fresh.tls_status === "renewing";
  const hadPrevious = await previousIsValid(fresh.domain, root);
  tlsLog("certificate.requested", {
    domain: fresh.domain,
    projectId: fresh.project_id,
    renewal: wasRenewal,
  });

  let obtained: Awaited<ReturnType<AcmeClient["requestCertificate"]>>;
  try {
    obtained = await deps.acmeClient.requestCertificate(fresh.domain, wasRenewal);
  } catch (error) {
    const done = await markCertificateFailed({
      domainId: fresh.id,
      code: error instanceof AcmeError ? error.code : "ACME_REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Certificate order failed",
      revertToIssued: wasRenewal && hadPrevious,
    });
    tlsLog("certificate.failed", {
      domain: fresh.domain,
      projectId: fresh.project_id,
      code: done.tls_last_error_code,
    });
    throw error;
  }
  let parsed: ParsedCertificate;
  try {
    parsed = validateCertificateForDomain(obtained.certificatePem, fresh.domain);
  } catch (error) {
    const done = await markCertificateFailed({
      domainId: fresh.id,
      code: "CERT_VALIDATION_FAILED",
      message: error instanceof Error ? error.message : "Certificate validation failed",
      revertToIssued: wasRenewal && hadPrevious,
    });
    tlsLog("certificate.failed", {
      domain: fresh.domain,
      projectId: fresh.project_id,
      code: done.tls_last_error_code,
    });
    throw error;
  }

  const fullchainPem = obtained.issuerPem
    ? `${obtained.certificatePem.trim()}\n${obtained.issuerPem.trim()}\n`
    : obtained.certificatePem;
  const installed = await installAtomically(fresh.domain, root, fullchainPem, obtained.privateKeyPem);

  const target = await resolveActiveRoute(fresh.project_id);
  if (target) {
    try {
      const router = deps.router ?? new NginxGatewayRouter();
      await syncProjectTarget(fresh.project_id, target, {
        router,
        timeoutMs: deps.httpsVerifyTimeoutMs ?? 30_000,
        certsRoot: root,
      });
    } catch (error) {
      if (hadPrevious) {
        await restorePrevious(fresh.domain, root, installed).catch(() => undefined);
      }
      const done = await markCertificateFailed({
        domainId: fresh.id,
        code: "GATEWAY_TLS_FAILED",
        message: error instanceof Error ? error.message : "Gateway TLS activation failed",
        revertToIssued: wasRenewal && hadPrevious,
      });
      tlsLog("gateway.tls_rollback", {
        domain: fresh.domain,
        projectId: fresh.project_id,
        code: done.tls_last_error_code,
      });
      throw error;
    }
  }

  const done = await markCertificateIssued({
    domainId: fresh.id,
    expectedTls: wasRenewal ? ["renewing", "pending"] : ["pending", "renewing"],
    expiresAt: parsed.expiresAt,
    certPath: certPathRef(fresh.domain),
  });
  tlsLog("certificate.issued", {
    domain: fresh.domain,
    projectId: fresh.project_id,
    expiresAt: parsed.expiresAt.toISOString(),
    fingerprint256: parsed.fingerprint256,
  });
  tlsLog("gateway.tls_activated", { domain: fresh.domain, projectId: fresh.project_id });
  return done;
}

export async function gcOrphanCertificates(root: string = certsDir(), cap = 10): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(path.join(root, "domains"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .slice(0, 100);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const existing = await pool.query(`SELECT domain FROM custom_domains WHERE domain = ANY($1)`, [names]);
  const live = new Set((existing.rows as Array<{ domain: string }>).map((r) => r.domain));
  let removed = 0;
  for (const name of names) {
    if (removed >= cap) break;
    if (live.has(name)) continue;
    if (!/^[a-z0-9.-]{1,253}$/.test(name) || name.includes("..")) continue;
    await rm(path.join(root, "domains", name), { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

export interface MaintenanceSummary {
  expired: number;
  claimed: number;
  issued: number;
  failed: number;
  orphansRemoved: number;
}

export async function runCertificateMaintenance(deps: IssuanceDeps): Promise<MaintenanceSummary> {
  const summary: MaintenanceSummary = { expired: 0, claimed: 0, issued: 0, failed: 0, orphansRemoved: 0 };
  const expiredProjects = await markExpiredCertificates();
  summary.expired = expiredProjects.length;
  if (expiredProjects.length > 0) {
    tlsLog("certificate.expired_sweep", { projects: expiredProjects.length });
    const { syncProjectGateway } = await import("./gatewayService.js");
    const { NginxGatewayRouter } = await import(
      "../infrastructure/gateway/nginxGatewayRouter.js"
    );
    for (const projectId of expiredProjects.slice(0, 20)) {
      try {
        await syncProjectGateway(
          projectId,
          deps.router ?? new NginxGatewayRouter(),
          deps.httpsVerifyTimeoutMs ?? 30_000
        );
      } catch (error) {
        tlsLog("gateway.tls_rollback", {
          projectId,
          code: "EXPIRY_RECONVERGE_FAILED",
          error: error instanceof Error ? error.message.slice(0, 200) : "reconverge failed",
        });
      }
    }
  }
  const claims = await claimDueCertificates(deps.maxClaimsPerSweep ?? 5);
  summary.claimed = claims.length;
  for (const claim of claims) {
    try {
      await processCertificateClaim(claim, deps);
      summary.issued++;
    } catch {
      summary.failed++;
    }
  }
  summary.orphansRemoved = await gcOrphanCertificates(deps.certsRoot ?? certsDir());
  return summary;
}
