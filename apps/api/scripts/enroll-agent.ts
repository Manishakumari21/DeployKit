

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
