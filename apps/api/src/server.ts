import "dotenv/config";
import app from "./app.js";
import { tokenPepperSource } from "./security/tokenHasher.js";

const PORT = process.env.PORT || 3000;

// Fail closed at boot: resolving the pepper throws in production when
// DEPLOYKIT_TOKEN_PEPPER is unset, so we never serve traffic that would mint
// session/agent tokens under an ephemeral, restart-invalidated key.
tokenPepperSource();

const server = app.listen(PORT, () => {
  console.log(`DeployKit API running on port ${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
