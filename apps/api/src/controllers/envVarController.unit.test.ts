import "../test/testEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createEnvVarControllers } from "./envVarController.js";
import { EnvVarError } from "../services/envVarService.js";

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
const VALID_VAR_ID = "00000000-0000-0000-0000-000000000002";
const INVALID_ID = "not-a-valid-uuid";

test("listEnvVarsController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { listEnvVarsController } = createEnvVarControllers({
    getProjectEnvVars: async () => {
      calls++;
      return [];
    },
  });

  const req = { params: { id: INVALID_ID } } as unknown as Request;
  const res = mockResponse();

  await listEnvVarsController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0, "Service must not be called when projectId is invalid");
});

test("listEnvVarsController with valid UUID invokes service with exact projectId and returns 200", async () => {
  let passedId: string | null = null;
  const mockVars = [{ id: VALID_VAR_ID, key: "PORT", value: "3000", isSecret: false }] as any;
  const { listEnvVarsController } = createEnvVarControllers({
    getProjectEnvVars: async (projectId: string) => {
      passedId = projectId;
      return mockVars;
    },
  });

  const req = { params: { id: VALID_PROJECT_ID } } as unknown as Request;
  const res = mockResponse();

  await listEnvVarsController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, mockVars);
  assert.equal(passedId, VALID_PROJECT_ID);
});

test("createEnvVarController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { createEnvVarController } = createEnvVarControllers({
    createProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: INVALID_ID },
    body: { key: "KEY", value: "VAL" },
  } as unknown as Request;
  const res = mockResponse();

  await createEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0, "Service must not be called when projectId is invalid");
});

test("createEnvVarController rejects missing key/value with 400 without calling service", async () => {
  let calls = 0;
  const { createEnvVarController } = createEnvVarControllers({
    createProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const reqMissingKey = {
    params: { id: VALID_PROJECT_ID },
    body: { value: "VAL" },
  } as unknown as Request;
  const res1 = mockResponse();
  await createEnvVarController(reqMissingKey, res1);
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.jsonData.error, "key is required");

  const reqMissingVal = {
    params: { id: VALID_PROJECT_ID },
    body: { key: "KEY" },
  } as unknown as Request;
  const res2 = mockResponse();
  await createEnvVarController(reqMissingVal, res2);
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.jsonData.error, "value is required");

  assert.equal(calls, 0, "Service must not be called when payload is invalid");
});

test("createEnvVarController with valid UUID invokes service with exact parameters and returns 201", async () => {
  let captured: any = null;
  const mockCreated = { id: VALID_VAR_ID, key: "DATABASE_URL", value: "postgres://...", isSecret: true };
  const { createEnvVarController } = createEnvVarControllers({
    createProjectEnvVar: async (projectId, input) => {
      captured = { projectId, input };
      return mockCreated as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID },
    body: { key: "DATABASE_URL", value: "postgres://...", isSecret: true },
  } as unknown as Request;
  const res = mockResponse();

  await createEnvVarController(req, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.jsonData, mockCreated);
  assert.equal(captured.projectId, VALID_PROJECT_ID);
  assert.deepEqual(captured.input, { key: "DATABASE_URL", value: "postgres://...", isSecret: true });
});

test("updateEnvVarController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { updateEnvVarController } = createEnvVarControllers({
    updateProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: INVALID_ID, varId: VALID_VAR_ID },
    body: { value: "new-val" },
  } as unknown as Request;
  const res = mockResponse();

  await updateEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("updateEnvVarController rejects non-UUID varId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { updateEnvVarController } = createEnvVarControllers({
    updateProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID, varId: INVALID_ID },
    body: { value: "new-val" },
  } as unknown as Request;
  const res = mockResponse();

  await updateEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid environment variable id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("updateEnvVarController rejects empty update body with 400 and does not invoke service", async () => {
  let calls = 0;
  const { updateEnvVarController } = createEnvVarControllers({
    updateProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID, varId: VALID_VAR_ID },
    body: {},
  } as unknown as Request;
  const res = mockResponse();

  await updateEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "At least one field (key, value, isSecret) must be provided");
  assert.equal(calls, 0);
});

test("updateEnvVarController with valid UUIDs invokes service with exact parameters and returns 200", async () => {
  let captured: any = null;
  const mockUpdated = { id: VALID_VAR_ID, key: "PORT", value: "8080", isSecret: false };
  const { updateEnvVarController } = createEnvVarControllers({
    updateProjectEnvVar: async (projectId, varId, input) => {
      captured = { projectId, varId, input };
      return mockUpdated as any;
    },
  });

  const req = {
    params: { id: VALID_PROJECT_ID, varId: VALID_VAR_ID },
    body: { value: "8080" },
  } as unknown as Request;
  const res = mockResponse();

  await updateEnvVarController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, mockUpdated);
  assert.equal(captured.projectId, VALID_PROJECT_ID);
  assert.equal(captured.varId, VALID_VAR_ID);
  assert.deepEqual(captured.input, { key: undefined, value: "8080", isSecret: undefined });
});

test("deleteEnvVarController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { deleteEnvVarController } = createEnvVarControllers({
    deleteProjectEnvVar: async () => {
      calls++;
      return true;
    },
  });

  const req = { params: { id: INVALID_ID, varId: VALID_VAR_ID } } as unknown as Request;
  const res = mockResponse();

  await deleteEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("deleteEnvVarController rejects non-UUID varId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { deleteEnvVarController } = createEnvVarControllers({
    deleteProjectEnvVar: async () => {
      calls++;
      return true;
    },
  });

  const req = { params: { id: VALID_PROJECT_ID, varId: INVALID_ID } } as unknown as Request;
  const res = mockResponse();

  await deleteEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid environment variable id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("deleteEnvVarController with valid UUIDs returns 404 if not found and 200 if deleted", async () => {
  let captured: any = null;
  const { deleteEnvVarController } = createEnvVarControllers({
    deleteProjectEnvVar: async (projectId, varId) => {
      captured = { projectId, varId };
      return varId === VALID_VAR_ID;
    },
  });

  const reqNotFound = {
    params: { id: VALID_PROJECT_ID, varId: "00000000-0000-0000-0000-000000000099" },
  } as unknown as Request;
  const resNotFound = mockResponse();
  await deleteEnvVarController(reqNotFound, resNotFound);
  assert.equal(resNotFound.statusCode, 404);
  assert.equal(resNotFound.jsonData.error, "Environment variable not found");

  const reqSuccess = {
    params: { id: VALID_PROJECT_ID, varId: VALID_VAR_ID },
  } as unknown as Request;
  const resSuccess = mockResponse();
  await deleteEnvVarController(reqSuccess, resSuccess);
  assert.equal(resSuccess.statusCode, 200);
  assert.equal(resSuccess.jsonData.message, "Environment variable deleted successfully");
  assert.equal(captured.projectId, VALID_PROJECT_ID);
  assert.equal(captured.varId, VALID_VAR_ID);
});

test("revealEnvVarController rejects non-UUID projectId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { revealEnvVarController } = createEnvVarControllers({
    revealProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = { params: { id: INVALID_ID, varId: VALID_VAR_ID } } as unknown as Request;
  const res = mockResponse();

  await revealEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid project id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("revealEnvVarController rejects non-UUID varId with 400 and does not invoke service", async () => {
  let calls = 0;
  const { revealEnvVarController } = createEnvVarControllers({
    revealProjectEnvVar: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = { params: { id: VALID_PROJECT_ID, varId: INVALID_ID } } as unknown as Request;
  const res = mockResponse();

  await revealEnvVarController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid environment variable id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("revealEnvVarController with valid UUIDs invokes service with exact parameters and returns 200", async () => {
  let captured: any = null;
  const mockRevealed = { id: VALID_VAR_ID, key: "SECRET_KEY", value: "super-secret" };
  const { revealEnvVarController } = createEnvVarControllers({
    revealProjectEnvVar: async (projectId, varId) => {
      captured = { projectId, varId };
      return mockRevealed as any;
    },
  });

  const req = { params: { id: VALID_PROJECT_ID, varId: VALID_VAR_ID } } as unknown as Request;
  const res = mockResponse();

  await revealEnvVarController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, mockRevealed);
  assert.equal(captured.projectId, VALID_PROJECT_ID);
  assert.equal(captured.varId, VALID_VAR_ID);
});

test("controllers propagate EnvVarError with exact status and code", async () => {
  const { listEnvVarsController } = createEnvVarControllers({
    getProjectEnvVars: async () => {
      throw new EnvVarError("FORBIDDEN", "Unauthorized project access", 403);
    },
  });

  const req = { params: { id: VALID_PROJECT_ID } } as unknown as Request;
  const res = mockResponse();

  await listEnvVarsController(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonData.error, "Unauthorized project access");
  assert.equal(res.jsonData.code, "FORBIDDEN");
});
