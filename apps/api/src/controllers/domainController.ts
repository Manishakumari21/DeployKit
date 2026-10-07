import type { Request, Response } from "express";
import { z } from "zod";
import { uuidParam } from "./http.js";
import { challengeRecordName, DomainError } from "../domains/domainName.js";
import {
  createDomain,
  deleteDomainRow,
  getDomainById,
  listDomains,
  verifyDomain,
  type DomainRow,
} from "../services/domainService.js";
import { requestCertificate, CertError } from "../services/certService.js";
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
    tls_requested_at: row.tls_requested_at,
    tls_last_attempt_at: row.tls_last_attempt_at,
    tls_last_error_code: row.tls_last_error_code,
    tls_last_error: row.tls_last_error,
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
  if (error instanceof CertError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("Domain error");
  res.status(500).json({ error: "Domain operation failed" });
}

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
    try {
      const { resolveActiveRoute, syncProjectTarget } = await import(
        "../services/gatewayService.js"
      );
      const target = await resolveActiveRoute(projectId);
      if (target) {
        try {
          await syncProjectTarget(projectId, target, { excludeDomains: [existing.domain] });
        } catch (error) {
          console.error("Domain removal gateway error");
          res.status(502).json({
            error: "Gateway update failed; domain was kept",
            code: "GATEWAY_SYNC_FAILED",
          });
          return;
        }
      }
    } catch (error) {
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

export async function requestCertificateController(req: Request, res: Response): Promise<void> {
  const domainId = uuidParam(req, res, "Invalid domain id");
  if (!domainId) return;
  try {
    const row = await requestCertificate(domainId);
    res.status(202).json(toPublicDomain(row));
  } catch (error) {
    domainError(res, error);
  }
}
