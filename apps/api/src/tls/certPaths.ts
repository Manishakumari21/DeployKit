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

export function gatewayCertPaths(domain: string): { certificate: string; key: string } {
  const normalized = normalizeDomain(domain);
  const dir = `${GATEWAY_CERTS_ROOT}/domains/${normalized}`;
  return {
    certificate: `${dir}/fullchain.pem`,
    key: `${dir}/private-key.pem`,
  };
}

export function gatewayChallengeRoot(): string {
  return `${GATEWAY_CERTS_ROOT}/challenges`;
}

export function acmeWorkDir(root: string = certsDir()): string {
  return path.join(root, "acme");
}

export function challengeWebroot(root: string = certsDir()): string {
  return path.join(root, "challenges");
}

export function challengeDir(root: string = certsDir()): string {
  return path.join(challengeWebroot(root), ".well-known", "acme-challenge");
}

export function certPathRef(domain: string): string {
  return `domains/${normalizeDomain(domain)}`;
}
