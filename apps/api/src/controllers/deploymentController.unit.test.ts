import test from "node:test";
import assert from "node:assert/strict";
import "../test/testEnv.js";
import { createDeploymentControllers } from "./deploymentController.js";
import { RateLimitError } from "../services/rateLimitService.js";
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
  params?: Record<string, string>;
  body?: any;
  query?: Record<string, any>;
  headers?: Record<string, string>;
  ip?: string;
  user?: { id: string };
} = {}): Request {
  const req: any = {
    params: options.params ?? {},
    body: options.body ?? {},
    query: options.query ?? {},
    headers: options.headers ?? {},
    ip: options.ip ?? "127.0.0.1",
    user: options.user,
    header(name: string) {
      return options.headers?.[name] ?? options.headers?.[name.toLowerCase()];
    },
  };
  return req as Request;
}

const VALID_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const VALID_DEPLOYMENT_ID = "22222222-2222-2222-2222-222222222222";
const VALID_RELEASE_ID = "33333333-3333-3333-3333-333333333333";
const VALID_CURSOR_UUID = "44444444-4444-4444-4444-444444444444";

test("createDeploymentController rejects invalid project id with 400 and does not call service or rate limiter", async () => {
  let rateLimitCalls = 0;
  let serviceCalls = 0;

  const { createDeploymentController } = createDeploymentControllers({
    checkDeploymentRateLimit: async () => { rateLimitCalls++; },
    createDeployment: async () => { serviceCalls++; return null as any; },
  });

  const req = createMockRequest({ params: { id: "not-a-uuid" } });
  const res = createMockResponse();

  await createDeploymentController(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid project id");
  assert.equal(rateLimitCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("createDeploymentController enforces rate limiting with 429 and Retry-After header", async () => {
  let serviceCalls = 0;

  const { createDeploymentController } = createDeploymentControllers({
    checkDeploymentRateLimit: async () => {
      throw new RateLimitError(45);
    },
    createDeployment: async () => {
      serviceCalls++;
      return null as any;
    },
  });

  const req = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    body: { trigger: "manual" },
    user: { id: "user-123" },
    ip: "10.0.0.1",
  });
  const res = createMockResponse();

  await createDeploymentController(req, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.getHeader("Retry-After"), "45");
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.equal(res.body.retryAfterSeconds, 45);
  assert.equal(serviceCalls, 0, "Service must not be invoked when rate limited");
});

test("createDeploymentController succeeds when within rate limit and calls service with exact args", async () => {
  let passedRateLimitArgs: any = null;
  let passedServiceArgs: any = null;

  const fakeDeployment = { id: VALID_DEPLOYMENT_ID, project_id: VALID_PROJECT_ID, status: "queued" };

  const { createDeploymentController } = createDeploymentControllers({
    checkDeploymentRateLimit: async (args) => {
      passedRateLimitArgs = args;
    },
    createDeployment: async (args) => {
      passedServiceArgs = args;
      return fakeDeployment as any;
    },
  });

  const req = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    body: { trigger: "manual" },
    headers: { "Idempotency-Key": "idem-key-1" },
    user: { id: "user-456" },
    ip: "192.168.1.10",
  });
  const res = createMockResponse();

  await createDeploymentController(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, fakeDeployment);
  assert.deepEqual(passedRateLimitArgs, {
    projectId: VALID_PROJECT_ID,
    userId: "user-456",
    ip: "192.168.1.10",
  });
  assert.deepEqual(passedServiceArgs, {
    projectId: VALID_PROJECT_ID,
    trigger: "manual",
    idempotencyKey: "idem-key-1",
    targetAgentId: null,
  });
});

test("rollbackDeploymentController enforces rate limiting with 429", async () => {
  let serviceCalls = 0;

  const { rollbackDeploymentController } = createDeploymentControllers({
    checkDeploymentRateLimit: async () => {
      throw new RateLimitError(30);
    },
    createDeployment: async () => {
      serviceCalls++;
      return null as any;
    },
  });

  const req = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    body: { releaseId: VALID_RELEASE_ID },
  });
  const res = createMockResponse();

  await rollbackDeploymentController(req, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.getHeader("Retry-After"), "30");
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.equal(serviceCalls, 0);
});

test("getProjectDeploymentsController rejects invalid pagination parameters with 400", async () => {
  let serviceCalls = 0;

  const { getProjectDeploymentsController } = createDeploymentControllers({
    getProjectDeployments: async () => {
      serviceCalls++;
      return [];
    },
  });

  // Out of range limit (> 100)
  const reqBadLimit = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { limit: "999" },
  });
  const resBadLimit = createMockResponse();
  await getProjectDeploymentsController(reqBadLimit, resBadLimit);
  assert.equal(resBadLimit.statusCode, 400);
  assert.equal(resBadLimit.body.code, "INVALID_QUERY");

  // Non-UUID cursor
  const reqBadCursor = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { cursor: "not-a-valid-uuid" },
  });
  const resBadCursor = createMockResponse();
  await getProjectDeploymentsController(reqBadCursor, resBadCursor);
  assert.equal(resBadCursor.statusCode, 400);
  assert.equal(resBadCursor.body.code, "INVALID_QUERY");

  assert.equal(serviceCalls, 0);
});

test("getProjectDeploymentsController passes valid limit and cursor and sets X-Next-Cursor header", async () => {
  let capturedOptions: any = null;
  const mockDeployments = [
    { id: "22222222-2222-2222-2222-222222222221", created_at: "2026-11-21T10:00:00Z" },
    { id: "22222222-2222-2222-2222-222222222222", created_at: "2026-11-21T09:00:00Z" },
  ];

  const { getProjectDeploymentsController } = createDeploymentControllers({
    getProjectDeployments: async (projectId, options) => {
      capturedOptions = options;
      return mockDeployments as any;
    },
  });

  const req = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { limit: "2", cursor: VALID_CURSOR_UUID },
  });
  const res = createMockResponse();

  await getProjectDeploymentsController(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, mockDeployments);
  assert.deepEqual(capturedOptions, { limit: 2, cursor: VALID_CURSOR_UUID });
  assert.equal(res.getHeader("X-Next-Cursor"), "22222222-2222-2222-2222-222222222222");
});

test("getDeploymentEventsController rejects invalid limit with 400 and passes valid pagination", async () => {
  let capturedOptions: any = null;

  const { getDeploymentEventsController } = createDeploymentControllers({
    getDeploymentById: async () => ({ id: VALID_DEPLOYMENT_ID }) as any,
    getDeploymentEvents: async (_id, options) => {
      capturedOptions = options;
      return [{ id: "1" }, { id: "2" }] as any;
    },
  });

  // Invalid limit > 200
  const reqBad = createMockRequest({
    params: { id: VALID_DEPLOYMENT_ID },
    query: { limit: "500" },
  });
  const resBad = createMockResponse();
  await getDeploymentEventsController(reqBad, resBad);
  assert.equal(resBad.statusCode, 400);
  assert.equal(resBad.body.code, "INVALID_QUERY");

  // Invalid non-numeric cursor
  const reqBadCursor = createMockRequest({
    params: { id: VALID_DEPLOYMENT_ID },
    query: { cursor: "not-a-number" },
  });
  const resBadCursor = createMockResponse();
  await getDeploymentEventsController(reqBadCursor, resBadCursor);
  assert.equal(resBadCursor.statusCode, 400);
  assert.equal(resBadCursor.body.code, "INVALID_QUERY");

  // Valid limit and numeric cursor
  const reqGood = createMockRequest({
    params: { id: VALID_DEPLOYMENT_ID },
    query: { limit: "2", cursor: "100" },
  });
  const resGood = createMockResponse();
  await getDeploymentEventsController(reqGood, resGood);
  assert.equal(resGood.statusCode, 200);
  assert.deepEqual(capturedOptions, { limit: 2, cursor: "100" });
  assert.equal(resGood.getHeader("X-Next-Cursor"), "2");
});

test("getProjectReleasesController passes valid limit and cursor and rejects out-of-range limit and invalid cursor", async () => {
  let capturedOptions: any = null;

  const { getProjectReleasesController } = createDeploymentControllers({
    getProjectReleases: async (_id, options) => {
      capturedOptions = options;
      return [{ id: VALID_RELEASE_ID }] as any;
    },
  });

  // Invalid limit 0
  const reqBad = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { limit: "0" },
  });
  const resBad = createMockResponse();
  await getProjectReleasesController(reqBad, resBad);
  assert.equal(resBad.statusCode, 400);

  // Invalid non-UUID cursor
  const reqBadCursor = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { cursor: "not-a-uuid" },
  });
  const resBadCursor = createMockResponse();
  await getProjectReleasesController(reqBadCursor, resBadCursor);
  assert.equal(resBadCursor.statusCode, 400);

  // Valid limit and UUID cursor
  const reqGood = createMockRequest({
    params: { id: VALID_PROJECT_ID },
    query: { limit: "1", cursor: VALID_CURSOR_UUID },
  });
  const resGood = createMockResponse();
  await getProjectReleasesController(reqGood, resGood);
  assert.equal(resGood.statusCode, 200);
  assert.deepEqual(capturedOptions, { limit: 1, cursor: VALID_CURSOR_UUID });
  assert.equal(resGood.getHeader("X-Next-Cursor"), VALID_RELEASE_ID);
});
