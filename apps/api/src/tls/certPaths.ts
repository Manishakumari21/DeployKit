// Phase 11.7: deterministic certificate filesystem layout.
// Certificates are a derived projection like gateway routes: PostgreSQL holds
// only metadata (tls_status, expiry, relative dir), never key material.
// Layout under DEPLOYKIT_CERTS_DIR (default /certs, the deploykit-certs
// volume: read/write in the worker, read-only in the gateway):
//
//   <certs>/accounts/                      ACME account data (lego-managed)
//   <certs>/challenges/                    HTTP-01 webroot (lego writes,
//     .well-known/acme-challenge/<token>   gateway serves on port 80)
//   <certs>/domains/<domain>/              one certificate per domain
//     fullchain.pem          (0644) nginx ssl_certificate
//     private-key.pem        (0600) nginx ssl_certificate_key
//
// The gateway sees the same volume at /etc/nginx/certs, so renderer paths
// are derived from the same relative layout (see gatewayCertPaths).

import path from "node:path";
import { normalizeDomain } from "../domains/domainName.js";

export const CERTS_DIR_DEFAULT = "/certs";
export const GATEWAY_CERTS_ROOT = "/etc/nginx/certs";

export const DOMAIN_DIR_MODE = 0o700;
export const CHALLENGE_DIR_MODE = 0o755;
export const PRIVATE_KEY_MODE = 0o600;
export const CERT_FILE_MODE = 0o644;

export class CertPathError extends Error {
  readonly code = "INVALID_CERT_PATH";
  constructor(message: string) {
    super(message);
    this.name = "CertPathError";
  }
}

export function certsDir(): string {
  const raw = (process.env.DEPLOYKIT_CERTS_DIR ?? CERTS_DIR_DEFAULT).trim();
  if (!raw || raw.includes("\0")) {
    throw new CertPathError("Invalid certificate directory");
  }
  return raw;
}

// Worker-side absolute paths. The domain is re-normalized so a corrupt DB
// row can never escape into a filesystem path (no traversal possible:
// normalized hostnames contain only [a-z0-9.-] with no ".." segments).
export function domainCertDir(domain: string, root: string = certsDir()): string {
  const normalized = normalizeDomain(domain);
  return path.join(root, "domains", normalized);
}

export function fullchainPath(domain: string, root: string = certsDir()): string {
  return path.join(domainCertDir(domain, root), "fullchain.pem");
}

export function privateKeyPath(domain: string, root: string = certsDir()): string {
  return path.join(domainCertDir(domain, root), "private-key.pem");
}

// Gateway-side paths for nginx ssl_certificate directives. Same relative
// layout under the volume's gateway mount point; never user-supplied.
export function gatewayCertPaths(domain: string): { certificate: string; key: string } {
  const normalized = normalizeDomain(domain);
  const dir = `${GATEWAY_CERTS_ROOT}/domains/${normalized}`;
  return {
    certificate: `${dir}/fullchain.pem`,
    key: `${dir}/private-key.pem`,
  };
}

// Gateway-side HTTP-01 webroot for the nginx challenge location.
// Same volume as certsDir, seen from the gateway mount point.
export function gatewayChallengeRoot(): string {
  return `${GATEWAY_CERTS_ROOT}/challenges`;
}

// Lego working state (ACME accounts + staging downloads). Kept inside the
// certs volume so account keys survive worker recreation without ever
// entering PostgreSQL or logs.
export function acmeWorkDir(root: string = certsDir()): string {
  return path.join(root, "acme");
}

// HTTP-01 webroot shared with the gateway. Lego writes challenge files to
// <webroot>/.well-known/acme-challenge/<token>; nginx serves exactly that
// subtree on port 80 and never redirects it to HTTPS.
export function challengeWebroot(root: string = certsDir()): string {
  return path.join(root, "challenges");
}

export function challengeDir(root: string = certsDir()): string {
  return path.join(challengeWebroot(root), ".well-known", "acme-challenge");
}

// Relative cert dir persisted in custom_domains.cert_path
// (e.g. "domains/example.com"). Absolute paths stay host-specific.
export function certPathRef(domain: string): string {
  return `domains/${normalizeDomain(domain)}`;
}
