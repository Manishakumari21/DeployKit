import express from "express";
import cors from "cors";
import { checkDatabase } from "./db/database.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  const dbUp = await checkDatabase();
  res.json({
    status: "ok",
    db: dbUp ? "up" : "down",
  });
});

export default app;