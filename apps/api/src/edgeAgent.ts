// DeployKit edge agent entry point.
//
// Standalone process: polls the control plane with machine credentials,
// executes edge-targeted deployments with the local Docker Engine, and
// exits. It never runs the central API or the central deployment worker.
//
// Run (production, from apps/api after `npm run build`):
//   DEPLOYKIT_CONTROL_PLANE_URL=https://control.example.com \
//   DEPLOYKIT_AGENT_TOKEN=<enrollment credential> \
//   node dist/edgeAgent.js
//
// See docs/edge-agent.md for prerequisites, enrollment, configuration,
// Docker socket implications, and troubleshooting.
import "dotenv/config";
import { runEdgeAgentFromEnv } from "./agents/edgeAgentRunner.js";

runEdgeAgentFromEnv(process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        component: "edge-agent",
        event: "agent.fatal",
        message: error instanceof Error ? error.message : "Unknown error",
      })
    );
    process.exitCode = 1;
  }
);
