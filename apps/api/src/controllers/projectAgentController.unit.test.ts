import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

if (process.env.DATABASE_URL && process.env.DATABASE_URL.endsWith("/deploykit")) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/deploykit$/, "/deploykit_test");
} else if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://deploykit:deploykit@localhost:5433/deploykit_test";
}

import {
  listProjectAgentsController,
  enrollProjectAgentController,
  revokeProjectAgentController,
} from "./projectAgentController.js";

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

test("enrollProjectAgentController rejects missing or whitespace name", async () => {
  const req = {
    params: { id: "00000000-0000-0000-0000-000000000001" },
    body: { name: "   " },
    headers: { host: "localhost:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.code, "INVALID_NAME");
});

test("enrollProjectAgentController rejects non-string name", async () => {
  const req = {
    params: { id: "00000000-0000-0000-0000-000000000001" },
    body: { name: 12345 },
    headers: { host: "localhost:3000" },
  } as unknown as Request;
  const res = mockResponse();

  await enrollProjectAgentController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.code, "INVALID_NAME");
});

test("revokeProjectAgentController returns 404 for nonexistent or mismatch agent", async () => {
  const req = {
    params: {
      id: "00000000-0000-0000-0000-000000000001",
      agentId: "00000000-0000-0000-0000-000000000002",
    },
  } as unknown as Request;
  const res = mockResponse();

  await revokeProjectAgentController(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonData.code, "AGENT_NOT_FOUND");
});
