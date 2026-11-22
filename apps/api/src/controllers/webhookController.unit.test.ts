import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import { createWebhookControllers } from "./webhookController.js";
import { RateLimitError } from "../services/rateLimitService.js";
import { WebhookVerifyError } from "../infrastructure/github/webhookVerify.js";
import { WebhookError } from "../services/webhookService.js";
import type { Request, Response } from "express";

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  return res as Response & { statusCode: number; headers: Record<string, string>; body: any };
}

function createMockRequest(options: {
  headers?: Record<string, string>;
  body?: any;
  ip?: string;
} = {}): Request {
  const req: any = {
    headers: options.headers ?? {},
    body: options.body ?? Buffer.from("{}"),
    ip: options.ip ?? "127.0.0.1",
    header(name: string) {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(options.headers ?? {})) {
        if (k.toLowerCase() === lower) return v;
      }
      return undefined;
    },
  };
  return req as Request;
}

test("githubWebhookController rejects missing headers with 400", async () => {
  let rateLimitCalls = 0;
  const { githubWebhookController } = createWebhookControllers({
    checkWebhookRateLimit: async () => { rateLimitCalls++; },
  });

  // Missing delivery
  const reqNoDelivery = createMockRequest({ headers: { "X-GitHub-Event": "push" } });
  const resNoDelivery = createMockResponse();
  await githubWebhookController(reqNoDelivery, resNoDelivery);
  assert.equal(resNoDelivery.statusCode, 400);
  assert.equal(resNoDelivery.body.error, "Missing X-GitHub-Delivery");
  assert.equal(rateLimitCalls, 0);

  // Missing event
  const reqNoEvent = createMockRequest({ headers: { "X-GitHub-Delivery": "del-1" } });
  const resNoEvent = createMockResponse();
  await githubWebhookController(reqNoEvent, resNoEvent);
  assert.equal(resNoEvent.statusCode, 400);
  assert.equal(resNoEvent.body.error, "Missing X-GitHub-Event");
  assert.equal(rateLimitCalls, 0);
});

test("githubWebhookController enforces rate limiting with 429 and Retry-After header", async () => {
  let verifyCalls = 0;
  let handlerCalls = 0;

  const { githubWebhookController } = createWebhookControllers({
    checkWebhookRateLimit: async () => {
      throw new RateLimitError(60);
    },
    verifyGitHubSignature: () => { verifyCalls++; },
    handleGitHubWebhook: async () => { handlerCalls++; return { status: "processed" }; },
  });

  const req = createMockRequest({
    headers: {
      "X-GitHub-Delivery": "del-123",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": "sha256=abcdef",
    },
    ip: "203.0.113.1",
  });
  const res = createMockResponse();

  await githubWebhookController(req, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.getHeader("Retry-After"), "60");
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.equal(res.body.retryAfterSeconds, 60);
  assert.equal(verifyCalls, 0, "Signature verification must not run when rate limited");
  assert.equal(handlerCalls, 0, "Webhook handler must not run when rate limited");
});

test("githubWebhookController rejects invalid signature with 401", async () => {
  let handlerCalls = 0;

  const { githubWebhookController } = createWebhookControllers({
    checkWebhookRateLimit: async () => {},
    getWebhookSecret: () => "mock-secret",
    verifyGitHubSignature: () => {
      throw new WebhookVerifyError("SIGNATURE_MISMATCH", "Signature mismatch", 401);
    },
    handleGitHubWebhook: async () => {
      handlerCalls++;
      return { status: "processed" };
    },
  });

  const req = createMockRequest({
    headers: {
      "X-GitHub-Delivery": "del-123",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": "sha256=bad",
    },
  });
  const res = createMockResponse();

  await githubWebhookController(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Invalid webhook signature");
  assert.equal(handlerCalls, 0);
});

test("githubWebhookController successfully processes valid webhook with 202", async () => {
  let capturedArgs: any = null;

  const { githubWebhookController } = createWebhookControllers({
    checkWebhookRateLimit: async () => {},
    getWebhookSecret: () => "mock-secret",
    verifyGitHubSignature: () => {},
    handleGitHubWebhook: async (args) => {
      capturedArgs = args;
      return { status: "processed", deploymentId: "dep-999" };
    },
  });

  const raw = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const req = createMockRequest({
    headers: {
      "X-GitHub-Delivery": "del-456",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": "sha256=good",
    },
    body: raw,
  });
  const res = createMockResponse();

  await githubWebhookController(req, res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { accepted: true, deploymentId: "dep-999" });
  assert.equal(capturedArgs.deliveryId, "del-456");
  assert.equal(capturedArgs.event, "push");
});

test("githubWebhookController propagates WebhookError status and message", async () => {
  const { githubWebhookController } = createWebhookControllers({
    checkWebhookRateLimit: async () => {},
    getWebhookSecret: () => "mock-secret",
    verifyGitHubSignature: () => {},
    handleGitHubWebhook: async () => {
      throw new WebhookError("UNSUPPORTED_REF", "Only branch pushes are supported", 202);
    },
  });

  const req = createMockRequest({
    headers: {
      "X-GitHub-Delivery": "del-tag",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": "sha256=good",
    },
  });
  const res = createMockResponse();

  await githubWebhookController(req, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.error, "Only branch pushes are supported");
});
