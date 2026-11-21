import "dotenv/config";
import app from "./app.js";
import pool from "./db/database.js";
import { tokenPepperSource } from "./security/tokenHasher.js";
import { createGracefulShutdown } from "./lifecycle/gracefulShutdown.js";

const PORT = process.env.PORT || 3000;

// Fail closed at boot: resolving the pepper throws in production when
// DEPLOYKIT_TOKEN_PEPPER is unset, so we never serve traffic that would mint
// session/agent tokens under an ephemeral, restart-invalidated key.
tokenPepperSource();

export const server = app.listen(PORT, () => {
  console.log(`DeployKit API running on port ${PORT}`);
});

export const shutdownController = createGracefulShutdown(server, pool);
shutdownController.registerSignalHandlers();
