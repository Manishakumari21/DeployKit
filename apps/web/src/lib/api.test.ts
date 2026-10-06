import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, cancelDeployment, createDeployment, fetchDeployment, fetchDeploymentEvents, fetchDeploymentLogs, fetchDeployments, fetchProjectMetrics, fetchSession, login, logout, register } from "./api";
import { isCancellableStatus, isTerminalStatus } from "../types";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: ok ? 200 : status })
  ) as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("deployment api client (HTTP boundary only)", () => {
  test("fetchDeployments hits the real endpoint and returns rows", async () => {
    const rows = [{ id: "d1", status: "queued" }];
    mockFetchOnce(rows);
    const out = await fetchDeployments("p1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/deployments", { credentials: "include" });
    expect(out).toEqual(rows);
  });

  test("createDeployment sends trigger + stable Idempotency-Key", async () => {
    mockFetchOnce({ id: "d2", status: "queued" });
    await createDeployment("p1", "key-123");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/deployments");
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toBe("key-123");
    expect(JSON.parse(init.body)).toEqual({ trigger: "manual" });
  });

  test("fetchDeployment + events use real routes", async () => {
    mockFetchOnce({ id: "d3", status: "active" });
    await fetchDeployment("d3");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d3", { credentials: "include", signal: undefined });
    mockFetchOnce([]);
    await fetchDeploymentEvents("d3");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d3/events", { credentials: "include" });
  });

  test("cancelDeployment posts to the real route", async () => {
    mockFetchOnce({ id: "d4", status: "cancelled" });
    await cancelDeployment("d4");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d4/cancel", { method: "POST", credentials: "include" });
  });

  test("non-2xx surfaces backend error, never silent success", async () => {
    mockFetchOnce({ error: "Cannot cancel deployment in status active" }, false, 409);
    await expect(cancelDeployment("d5")).rejects.toThrow("Cannot cancel deployment in status active");
  });

  test("network failure surfaces, last-known status preserved by caller", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchDeployment("d6")).rejects.toThrow("Could not reach the API");
  });

  test("fetchDeploymentLogs uses cursor pagination query", async () => {
    mockFetchOnce({ items: [], next_cursor: null, truncated: false });
    await fetchDeploymentLogs("d7", { cursor: "42", limit: 50, source: "build", direction: "asc" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/deployments/d7/logs?");
    expect(url).toContain("cursor=42");
    expect(url).toContain("source=build");
  });

  test("fetchProjectMetrics hits the project-scoped route", async () => {
    mockFetchOnce({ project_id: "p1" });
    await fetchProjectMetrics("p1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/metrics", { credentials: "include", signal: undefined });
  });
});

describe("status grouping matches backend state machine", () => {
  test("terminal states stop polling", () => {
    for (const s of ["active", "failed", "cancelled"] as const) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["queued", "cloning", "building", "pushing", "verifying", "deploying"] as const)
      expect(isTerminalStatus(s)).toBe(false);
  });

  test("cancel allowed exactly in non-terminal states", () => {
    expect(isCancellableStatus("building")).toBe(true);
    expect(isCancellableStatus("active")).toBe(false);
    expect(isCancellableStatus("failed")).toBe(false);
  });
});

describe("auth api client (session cookie only, never token state)", () => {
  test("fetchSession probes the session endpoint with credentials", async () => {
    const user = { id: "u1", email: "a@example.com" };
    mockFetchOnce({ user });
    const out = await fetchSession();
    expect(out).toEqual(user);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/session", { credentials: "include" });
  });

  test("login posts credentials and returns the user", async () => {
    mockFetchOnce({ id: "u1", email: "a@example.com" });
    await login({ email: "a@example.com", password: "correct-horse-123" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({ email: "a@example.com", password: "correct-horse-123" });
  });

  test("register posts to the register route and logout posts with credentials", async () => {
    mockFetchOnce({ id: "u2", email: "b@example.com" });
    await register({ email: "b@example.com", password: "correct-horse-123" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/auth/register");
    mockFetchOnce({ loggedOut: true });
    await logout();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/logout", { method: "POST", credentials: "include" });
  });

  test("401 surfaces as ApiError with status for auth gating", async () => {
    mockFetchOnce({ error: "Authentication required" }, false, 401);
    const err = await fetchSession().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
