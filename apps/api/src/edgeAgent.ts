

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
