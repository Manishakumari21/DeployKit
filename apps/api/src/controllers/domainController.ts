// Phase 11.4: thin custom-domain controllers. Authentication and project
// membership are enforced by middleware; this layer only maps service
// results to safe HTTP shapes. Verification tokens and hashes are never
// logged here.

import type { Request, Response } from "express";
import { z } from "zod";
import { uuidParam } from "./http.js";
import { challengeRecordName, DomainError } from "../domains/domainName.js";
import {
  createDomain,
  deleteDomainRow,
  getDomainById,
  getVerifiedDomains,
  listDomains,
  verifyDomain,
  type DomainRow,
} from "../services/domainService.js";
import { TrafficRouterError } from "../infrastructure/gateway/trafficRouter.js";

const domainBody = z.object({ domain: z.string().min(1).max(253) });

function toPublicDomain(row: DomainRow, token?: string) {
  const base = {
    id: row.id,
    project_id: row.project_id,
    domain: row.domain,
    status: row.status,
    verification: {
      type: "dns-txt" as const,
      name: challengeRecordName(row.domain),
      ...(token ? { value: token } : {}),
    },
    verified_at: row.verified_at,
    tls_status: row.tls_status,
    cert_expires_at: row.cert_expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return base;
}

function domainError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("Domain error");
  res.status(500).json({ error: "Domain operation failed" });
}

// POST /api/projects/:id/domains — requireProjectAccess guarantees membership.
export async function createDomainController(req: Request, res: Response): Promise<void> {
  const projectId = uuidParam(req, res, "Invalid project id");
  if (!projectId) return;
  const parsed = domainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid hostname", code: "INVALID_HOSTNAME" });
    return;
  }
  try {
    const created = await createDomain({ projectId, domain: parsed.data.domain });
    res.status(201).json(toPublicDomain(created.row, created.verificationToken));
  } catch (error) {
    domainError(res, error);
  }
}

// GET /api/projects/:id/domains — requireProjectAccess guarantees membership.
export async function listDomainsController(req: Request, res: Response): Promise<void> {
  const projectId = uuidParam(req, res, "Invalid project id");
  if (!projectId) return;
  try {
    const rows = await listDomains(projectId);
    res.json(rows.map((r) => toPublicDomain(r)));
  } catch {
    console.error("Domain list error");
    res.status(500).json({ error: "Failed to fetch domains" });
  }
}

// GET /api/domains/:id — requireDomainRouteAccess guarantees membership.
export async function getDomainController(req: Request, res: Response): Promise<void> {
  const domainId = uuidParam(req, res, "Invalid domain id");
  if (!domainId) return;
  try {
    const row = await getDomainById(domainId);
    if (!row) {
      res.status(404).json({ error: "Domain not found", code: "DOMAIN_NOT_FOUND" });
      return;
    }
    res.json(toPublicDomain(row));
  } catch {
    console.error("Domain lookup error");
    res.status(500).json({ error: "Failed to fetch domain" });
  }
}

// POST /api/domains/:id/verify — DNS TXT ownership check, then converge the
// gateway projection when an active runtime exists. Verified means ownership
// proven, not necessarily routed: projects without deployments verify first
// and route on the next activation.
export async function verifyDomainController(req: Request, res: Response): Promise<void> {
  const domainId = uuidParam(req, res, "Invalid domain id");
  if (!domainId) return;
  const projectId = req.projectId;
  if (!projectId) {
    res.status(500).json({ error: "Domain operation failed" });
    return;
  }
  try {
    const { row } = await verifyDomain(domainId);
    // Best-effort gateway convergence: no active route yet is not a failure.
    try {
      const { syncProjectGateway } = await import("../services/gatewayService.js");
      const { NginxGatewayRouter } = await import(
        "../infrastructure/gateway/nginxGatewayRouter.js"
      );
      await syncProjectGateway(projectId, new NginxGatewayRouter(), 10_000);
    } catch (error) {
      if (
        error instanceof TrafficRouterError &&
        (error.code === "NO_ACTIVE_ROUTE" || error.code === "ROUTE_NOT_READY")
      ) {
        // Ownership is still proven; routing follows on next activation.
        // Fall through to 200 below for NO_ACTIVE_ROUTE; ROUTE_NOT_READY
        // means the candidate did not verify — keep verified but report.
        if (error.code === "NO_ACTIVE_ROUTE") {
          res.json(toPublicDomain(row));
          return;
        }
      }
      console.error("Domain gateway convergence error");
      res.status(502).json({
        error: "Domain verified but gateway route failed",
        code: "GATEWAY_SYNC_FAILED",
        domain: toPublicDomain(row),
      });
      return;
    }
    res.json(toPublicDomain(row));
  } catch (error) {
    if (error instanceof DomainError && error.code === "VERIFICATION_EXPIRED") {
      const rotated = (error as unknown as { rotated?: { row: DomainRow; verificationToken: string } })
        .rotated;
      res.status(410).json({
        error: error.message,
        code: error.code,
        ...(rotated
          ? { domain: toPublicDomain(rotated.row, rotated.verificationToken) }
          : {}),
      });
      return;
    }
    domainError(res, error);
  }
}

// DELETE /api/domains/:id — converge the gateway first (without this alias),
// verify the result, and only then finalize the row deletion. Missing rows
// stay 404 (stable across retries, matching project deletion convention).
export async function deleteDomainController(req: Request, res: Response): Promise<void> {
  const domainId = uuidParam(req, res, "Invalid domain id");
  if (!domainId) return;
  const projectId = req.projectId;
  if (!projectId) {
    res.status(500).json({ error: "Domain operation failed" });
    return;
  }
  try {
    const existing = await getDomainById(domainId);
    if (!existing) {
      res.status(404).json({ error: "Domain not found", code: "DOMAIN_NOT_FOUND" });
      return;
    }
    // When an active runtime exists, rewrite the projection without this
    // domain and verify before deleting. Without an active route there is
    // no file to converge, so deletion proceeds directly.
    const remaining = (await getVerifiedDomains(projectId)).filter(
      (d) => d !== existing.domain
    );
    try {
      const { resolveActiveRoute } = await import("../services/gatewayService.js");
      const target = await resolveActiveRoute(projectId);
      if (target) {
        const { NginxGatewayRouter } = await import(
          "../infrastructure/gateway/nginxGatewayRouter.js"
        );
        const router = new NginxGatewayRouter();
        const previous = await router.readRawConfig(projectId);
        try {
          await router.sync(target, remaining);
          await router.verifyRoute(target, 10_000);
        } catch (error) {
          try {
            await router.restoreRawConfig(projectId, previous);
          } catch {
            // Best-effort restore.
          }
          console.error("Domain removal gateway error");
          res.status(502).json({
            error: "Gateway update failed; domain was kept",
            code: "GATEWAY_SYNC_FAILED",
          });
          return;
        }
      }
    } catch (error) {
      if (error instanceof Response) throw error;
      // resolveActiveRoute returning null is handled above (no target);
      // unexpected DB errors fall through to 500 below.
      if (error instanceof TrafficRouterError) {
        console.error("Domain removal gateway error");
        res.status(502).json({
          error: "Gateway update failed; domain was kept",
          code: "GATEWAY_SYNC_FAILED",
        });
        return;
      }
      throw error;
    }
    const deleted = await deleteDomainRow(domainId);
    if (!deleted) {
      res.status(404).json({ error: "Domain not found", code: "DOMAIN_NOT_FOUND" });
      return;
    }
    res.json({ removed: true, id: deleted.id });
  } catch (error) {
    console.error("Domain deletion error");
    res.status(500).json({ error: "Failed to delete domain" });
  }
}
