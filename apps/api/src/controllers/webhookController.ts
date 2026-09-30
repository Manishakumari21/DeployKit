import type { Request, Response } from "express";
import { getWebhookSecret } from "../infrastructure/github/githubConfig.js";
import { verifyGitHubSignature, WebhookVerifyError } from "../infrastructure/github/webhookVerify.js";
import { handleGitHubWebhook, WebhookError } from "../services/webhookService.js";

function safeLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields }));
}

export async function githubWebhookController(req: Request, res: Response): Promise<void> {
  const deliveryId = String(req.header("X-GitHub-Delivery") ?? "").trim();
  const event = String(req.header("X-GitHub-Event") ?? "").trim();
  const signature = req.header("X-Hub-Signature-256") ?? undefined;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  if (!deliveryId) {
    res.status(400).json({ error: "Missing X-GitHub-Delivery" });
    return;
  }
  if (!event) {
    res.status(400).json({ error: "Missing X-GitHub-Event" });
    return;
  }

  try {
    verifyGitHubSignature(rawBody, signature, getWebhookSecret());
  } catch (error) {
    const status = error instanceof WebhookVerifyError ? error.status : 401;
    safeLog("webhook.signature_rejected", { deliveryId, event });
    res.status(status).json({ error: "Invalid webhook signature" });
    return;
  }

  try {
    const outcome = await handleGitHubWebhook({ deliveryId, event, rawBody });
    if (outcome.status === "processed") {
      safeLog("webhook.processed", { deliveryId, event, deploymentId: outcome.deploymentId });
      res.status(202).json({ accepted: true, deploymentId: outcome.deploymentId });
    } else if (outcome.status === "duplicate") {
      safeLog("webhook.duplicate", { deliveryId, event });
      res.status(202).json({ accepted: true, duplicate: true });
    } else {
      safeLog("webhook.ignored", { deliveryId, event, reason: outcome.reason });
      res.status(202).json({ accepted: true, ignored: true, reason: outcome.reason });
    }
  } catch (error) {
    if (error instanceof WebhookError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error("GitHub webhook error");
    res.status(500).json({ error: "Failed to process webhook" });
  }
}
