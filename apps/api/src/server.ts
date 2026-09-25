import "dotenv/config";
import app from "./app.js";
import { env, assertEnv } from "./config/env.js";

assertEnv();
const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`DeployKit API running on port ${PORT}`);
});