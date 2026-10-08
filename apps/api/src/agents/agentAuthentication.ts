import {
  resolveCredential as defaultResolveCredential,
  type ResolvedAgentCredential,
} from "./agentService.js";

export interface AgentRequestContext {
  agentId: string;
  projectId: string;
  credentialId: string;
}

export type AgentCredentialResolver = (
  token: string
) => Promise<ResolvedAgentCredential | null>;

export function parseBearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  if (token.length === 0 || /\s/.test(token)) return null;
  return token;
}

export async function authenticateAgentToken(
  header: unknown,
  resolve: AgentCredentialResolver = defaultResolveCredential
): Promise<AgentRequestContext | null> {
  const token = parseBearerToken(header);
  if (token === null) return null;
  const resolved = await resolve(token);
  if (resolved === null) return null;
  return {
    agentId: resolved.agentId,
    projectId: resolved.projectId,
    credentialId: resolved.credentialId,
  };
}
