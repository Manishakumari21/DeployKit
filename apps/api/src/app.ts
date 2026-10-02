import express from "express";
import cors from "cors";
import pool from "./db/database.js";
import projectRoutes from "./routes/projectRoutes.js";
import deploymentRoutes from "./routes/deploymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";

const app = express();

app.use(cors());

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

export default app;
