// Manual edge-agent enrollment (control-plane operator use only).
//
// There is intentionally no public enrollment endpoint: creating agents and
// issuing credentials requires control-plane access (DATABASE_URL) and is
// performed by the project owner/operator. This script reuses the existing
// service mechanism (createAgent + createEnrollmentCredential: 256-bit
// opaque token, SHA-256 digest storage). The raw token is printed ONCE for
// handoff to the edge host; only its digest is stored.
//
// Usage (from apps/api, with DATABASE_URL set):
//   npx tsx scripts/enroll-agent.ts --project <project-uuid> --name <agent-name> [--expires <ISO timestamp>]
//
// Rotation: run again (or rotateCredential path) and replace the token on
// the edge host, then revoke the old credential.
// Revocation: revokeCredential(credentialId) or revokeAgent(agentId) via
// the same service module; the agent stops at the next authenticated call.

import { createAgent, createEnrollmentCredential } from "../src/agents/agentService.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

async function main(): Promise<number> {
  const projectId = argValue("--project");
  const name = argValue("--name");
  const expires = argValue("--expires");
  if (!projectId || !name) {
    console.error(
      "Usage: npx tsx scripts/enroll-agent.ts --project <project-uuid> --name <agent-name> [--expires <ISO timestamp>]"
    );
    return 2;
  }
  try {
    const agent = await createAgent(projectId, name);
    const credential = await createEnrollmentCredential(
      agent.id,
      expires ? { expiresAt: expires } : undefined
    );
    console.log(
      JSON.stringify({
        agentId: agent.id,
        projectId: agent.projectId,
        credentialId: credential.id,
        expiresAt: credential.expiresAt,
      })
    );
    console.log(
      "EDGE AGENT TOKEN (copy now; it is never shown again and only its digest is stored):"
    );
    console.log(credential.token);
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Enrollment failed"
    );
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : "Enrollment failed");
    process.exitCode = 1;
  }
);
