import "../test/testEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createProjectAgentControllers } from "./projectAgentController.js";
import { AgentError } from "../agents/agentService.js";

function mockResponse() {
  const res = {
    statusCode: 200,
    jsonData: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.jsonData = data;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; jsonData: any };
}

const VALID_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const VALID_AGENT_ID = "00000000-0000-0000-0000-000000000002";
const INVALID_ID = "not-a-valid-uuid";

test("enrollProjectAgentController rejects missing or whitespace name without invoking service", async () => {
  let calls = 0;
  const { enrollProjectAgentController } = createProjectAgentControllers({
    createAgent: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID },
    body: { name: "   " },
    headers: { host: "localhost:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.code, "INVALID_NAME");
  assert.equal(calls, 0);
});

test("enrollProjectAgentController rejects non-string name without invoking service", async () => {
  let calls = 0;
  const { enrollProjectAgentController } = createProjectAgentControllers({
    createAgent: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID },
    body: { name: 12345 },
    headers: { host: "localhost:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.code, "INVALID_NAME");
  assert.equal(calls, 0);
});

test("enrollProjectAgentController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { enrollProjectAgentController } = createProjectAgentControllers({
    createAgent: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: INVALID_ID },
    body: { name: "my-edge-agent" },
    headers: { host: "localhost:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("enrollProjectAgentController with valid UUID and name calls services and returns 201", async () => {
  let createAgentCaptured: any = null;
  let createCredCaptured: any = null;
  const mockAgent = { id: VALID_AGENT_ID, projectId: VALID_PROJECT_ID, name: "prod-worker-1" };
  const mockCred = { id: "cred-1", token: "tok_secret_123", expiresAt: new Date("2027-01-01T00:00:00Z") };

  const { enrollProjectAgentController } = createProjectAgentControllers({
    createAgent: async (projId, name) => {
      createAgentCaptured = { projId, name };
      return mockAgent as any;
    },
    createEnrollmentCredential: async (agentId, options) => {
      createCredCaptured = { agentId, options };
      return mockCred as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID },
    body: { name: "  prod-worker-1  " },
    headers: { host: "deploykit.internal:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.jsonData.agent, mockAgent);
  assert.equal(res.jsonData.credential.token, "tok_secret_123");
  assert.ok(res.jsonData.installCommand.includes("dk-agent-00000000"));
  assert.equal(createAgentCaptured.projId, VALID_PROJECT_ID);
  assert.equal(createAgentCaptured.name, "prod-worker-1");
  assert.equal(createCredCaptured.agentId, VALID_AGENT_ID);
});

test("revokeProjectAgentController returns 404 for nonexistent or mismatch agent", async () => {
  let revokeCalls = 0;
  const { revokeProjectAgentController } = createProjectAgentControllers({
    getAgentById: async () => null,
    revokeAgent: async () => {
      revokeCalls++;
      return true;
    },
  });

  const req = {
    params: {
      id: VALID_PROJECT_ID,
      agentId: VALID_AGENT_ID,
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonData.code, "AGENT_NOT_FOUND");
  assert.equal(revokeCalls, 0, "revokeAgent must not be called when agent not found");
});

test("revokeProjectAgentController returns 404 when agent projectId does not match param", async () => {
  let revokeCalls = 0;
  const { revokeProjectAgentController } = createProjectAgentControllers({
    getAgentById: async () => ({ id: VALID_AGENT_ID, projectId: "00000000-0000-0000-0000-999999999999" } as any),
    revokeAgent: async () => {
      revokeCalls++;
      return true;
    },
  });

  const req = {
    params: {
      id: VALID_PROJECT_ID,
      agentId: VALID_AGENT_ID,
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonData.code, "AGENT_NOT_FOUND");
  assert.equal(revokeCalls, 0);
});

test("revokeProjectAgentController rejects non-UUID agentId with 400 and INVALID_ID code", async () => {
  let getCalls = 0;
  let revokeCalls = 0;
  const { revokeProjectAgentController } = createProjectAgentControllers({
    getAgentById: async () => {
      getCalls++;
      return null;
    },
    revokeAgent: async () => {
      revokeCalls++;
      return true;
    },
  });

  const req = {
    params: {
      id: VALID_PROJECT_ID,
      agentId: INVALID_ID,
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid agent id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(getCalls, 0);
  assert.equal(revokeCalls, 0);
});

test("revokeProjectAgentController rejects invalid projectId with 400 and INVALID_ID code", async () => {
  let getCalls = 0;
  let revokeCalls = 0;
  const { revokeProjectAgentController } = createProjectAgentControllers({
    getAgentById: async () => {
      getCalls++;
      return null;
    },
    revokeAgent: async () => {
      revokeCalls++;
      return true;
    },
  });

  const req = {
    params: {
      id: INVALID_ID,
      agentId: VALID_AGENT_ID,
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(getCalls, 0);
  assert.equal(revokeCalls, 0);
});

test("revokeProjectAgentController with valid UUIDs revokes agent and returns 200", async () => {
  let revokedAgentId: string | null = null;
  const { revokeProjectAgentController } = createProjectAgentControllers({
    getAgentById: async (agentId) => ({ id: agentId, projectId: VALID_PROJECT_ID } as any),
    revokeAgent: async (agentId) => {
      revokedAgentId = agentId;
      return true;
    },
  });

  const req = {
    params: {
      id: VALID_PROJECT_ID,
      agentId: VALID_AGENT_ID,
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonData.message, "Server agent revoked successfully");
  assert.equal(revokedAgentId, VALID_AGENT_ID);
});

test("listProjectAgentsController rejects invalid projectId with 400 and INVALID_ID code", async () => {
  let calls = 0;
  const { listProjectAgentsController } = createProjectAgentControllers({
    listProjectAgents: async () => {
      calls++;
      return [];
    },
  });

  const req = {
    params: { id: INVALID_ID },
  } as unknown as Request;
  const res = mockResponse();

  await listProjectAgentsController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("listProjectAgentsController with valid UUID invokes service with exact projectId and returns 200", async () => {
  let capturedProjectId: string | null = null;
  const mockAgents = [{ id: VALID_AGENT_ID, name: "agent-1" }] as any;
  const { listProjectAgentsController } = createProjectAgentControllers({
    listProjectAgents: async (projId) => {
      capturedProjectId = projId;
      return mockAgents;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID },
  } as unknown as Request;
  const res = mockResponse();

  await listProjectAgentsController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, mockAgents);
  assert.equal(capturedProjectId, VALID_PROJECT_ID);
});

test("projectAgent controllers propagate AgentError with exact status and code", async () => {
  const { listProjectAgentsController } = createProjectAgentControllers({
    listProjectAgents: async () => {
      throw new AgentError("AGENT_QUOTA_EXCEEDED", "Agent quota exceeded", 429);
    },
  });

  const req = { params: { id: VALID_PROJECT_ID } } as unknown as Request;
  const res = mockResponse();

  await listProjectAgentsController(req, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.jsonData.error, "Agent quota exceeded");
  assert.equal(res.jsonData.code, "AGENT_QUOTA_EXCEEDED");
});
