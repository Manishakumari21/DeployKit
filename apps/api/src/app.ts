import express from "express";
import cors from "cors";
import pool from "./db/database.js";
import { buildCorsOptions } from "./config/corsConfig.js";
import projectRoutes from "./routes/projectRoutes.js";
import deploymentRoutes from "./routes/deploymentRoutes.js";
import domainRoutes from "./routes/domainRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import authRoutes from "./routes/authRoutes.js";

const app = express();

// Explicit origins + credentials. Throws at startup on unsafe combinations
// (wildcard with credentials, missing origin in production).
app.use(cors(buildCorsOptions()));

app.use(
  "/api/webhooks",
  express.raw({ type: "*/*", limit: "1mb" }),
  webhookRoutes
);

app.use(express.json());

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.use("/api/projects", projectRoutes);
app.use("/api", deploymentRoutes);
app.use("/api", domainRoutes);
app.use("/api/auth", authRoutes);

export default app;
