import "../test/testEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createUserControllers } from "./userController.js";
import { UserError } from "../services/userService.js";
import { InviteError } from "../services/inviteService.js";
import { RateLimitError } from "../services/rateLimitService.js";

function mockResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    jsonData: null as any,
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.jsonData = data;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; jsonData: any; headers: Record<string, string> };
}

const VALID_USER_ID = "00000000-0000-0000-0000-000000000001";
const VALID_INVITE_ID = "00000000-0000-0000-0000-000000000002";
const ADMIN_ID = "00000000-0000-0000-0000-000000000099";
const INVALID_ID = "not-a-valid-uuid";

test("updateUserController rejects non-UUID id with 400 and INVALID_ID code without calling service", async () => {
  let calls = 0;
  const { updateUserController } = createUserControllers({
    setUserDisabled: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: INVALID_ID },
    body: { disabled: true },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await updateUserController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid user id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("updateUserController rejects invalid request payload with 400 without calling service", async () => {
  let calls = 0;
  const { updateUserController } = createUserControllers({
    setUserDisabled: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: VALID_USER_ID },
    body: { disabled: "not-a-boolean" },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await updateUserController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid request");
  assert.equal(calls, 0);
});

test("updateUserController with valid UUID calls service with exact arguments and returns user", async () => {
  let captured: any = null;
  const mockUser = { id: VALID_USER_ID, email: "user@example.com", disabled: true };
  const { updateUserController } = createUserControllers({
    setUserDisabled: async (userId, disabled, adminId) => {
      captured = { userId, disabled, adminId };
      return mockUser as any;
    },
  });

  const req = {
    params: { id: VALID_USER_ID },
    body: { disabled: true },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await updateUserController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, { user: mockUser });
  assert.deepEqual(captured, { userId: VALID_USER_ID, disabled: true, adminId: ADMIN_ID });
});

test("updateUserController propagates UserError with status and code", async () => {
  const { updateUserController } = createUserControllers({
    setUserDisabled: async () => {
      throw new UserError("USER_NOT_FOUND", "User not found", 404);
    },
  });

  const req = {
    params: { id: VALID_USER_ID },
    body: { disabled: true },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await updateUserController(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonData.error, "User not found");
  assert.equal(res.jsonData.code, "USER_NOT_FOUND");
});

test("revokeInviteController rejects non-UUID id with 400 and INVALID_ID code without calling service", async () => {
  let calls = 0;
  const { revokeInviteController } = createUserControllers({
    revokeInvite: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    params: { id: INVALID_ID },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await revokeInviteController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid invite id");
  assert.equal(res.jsonData.code, "INVALID_ID");
  assert.equal(calls, 0);
});

test("revokeInviteController with valid UUID calls service with exact argument and returns invite", async () => {
  let capturedInviteId: string | null = null;
  const mockInvite = { id: VALID_INVITE_ID, email: "invited@example.com", revokedAt: new Date() };
  const { revokeInviteController } = createUserControllers({
    revokeInvite: async (id) => {
      capturedInviteId = id;
      return mockInvite as any;
    },
  });

  const req = {
    params: { id: VALID_INVITE_ID },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await revokeInviteController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, { invite: mockInvite });
  assert.equal(capturedInviteId, VALID_INVITE_ID);
});

test("revokeInviteController propagates InviteError with status and code", async () => {
  const { revokeInviteController } = createUserControllers({
    revokeInvite: async () => {
      throw new InviteError("INVITE_NOT_FOUND", "Invite not found", 404);
    },
  });

  const req = {
    params: { id: VALID_INVITE_ID },
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await revokeInviteController(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonData.error, "Invite not found");
  assert.equal(res.jsonData.code, "INVITE_NOT_FOUND");
});

test("listUsersController calls listUsers and returns 200 with users list", async () => {
  const mockUsers = [{ id: VALID_USER_ID, email: "admin@example.com" }] as any;
  const { listUsersController } = createUserControllers({
    listUsers: async () => mockUsers,
  });

  const req = {
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await listUsersController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, { users: mockUsers });
});

test("createInviteController rejects invalid email without calling service", async () => {
  let calls = 0;
  const { createInviteController } = createUserControllers({
    createInvite: async () => {
      calls++;
      return {} as any;
    },
  });

  const req = {
    body: { email: "no" },
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  } as unknown as Request;
  const res = mockResponse();

  await createInviteController(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonData.error, "Invalid invite request");
  assert.equal(calls, 0);
});

test("createInviteController handles rate limiting with 429 and Retry-After header", async () => {
  const { createInviteController } = createUserControllers({
    checkAuthRateLimit: async () => {
      throw new RateLimitError(60);
    },
  });

  const req = {
    body: { email: "test@example.com" },
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  } as unknown as Request;
  const res = mockResponse();

  await createInviteController(req, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.jsonData.error, "Too many attempts");
  assert.equal(res.headers["retry-after"], "60");
});

test("createInviteController with valid email calls service and returns 201 with invite and token", async () => {
  let captured: any = null;
  const mockInvite = { id: VALID_INVITE_ID, email: "colleague@example.com" };
  const { createInviteController } = createUserControllers({
    checkAuthRateLimit: async () => {},
    createInvite: async (email, adminId) => {
      captured = { email, adminId };
      return { invite: mockInvite, token: "raw_invite_token_123" } as any;
    },
  });

  const req = {
    body: { email: "colleague@example.com" },
    auth: { userId: ADMIN_ID },
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  } as unknown as Request;
  const res = mockResponse();

  await createInviteController(req, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.jsonData, { invite: mockInvite, token: "raw_invite_token_123" });
  assert.deepEqual(captured, { email: "colleague@example.com", adminId: ADMIN_ID });
});

test("listInvitesController calls listInvites and returns 200 with invites list", async () => {
  const mockInvites = [{ id: VALID_INVITE_ID, email: "invited@example.com" }] as any;
  const { listInvitesController } = createUserControllers({
    listInvites: async () => mockInvites,
  });

  const req = {
    auth: { userId: ADMIN_ID },
  } as unknown as Request;
  const res = mockResponse();

  await listInvitesController(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonData, { invites: mockInvites });
});
