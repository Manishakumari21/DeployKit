import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, acknowledgeIncident, cancelDeployment, createDeployment, detectProject, fetchBuildConfig, fetchDeployment, fetchDeploymentEvents, fetchDeploymentLogs, fetchDeployments, fetchIncident, fetchIncidents, fetchProjectMetrics, fetchSession, login, logout, register, resetBuildConfig, resolveIncident, saveBuildConfig } from "./api";
import type { BuildConfig } from "./buildConfig";
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

describe("build configuration api client", () => {
  const config: BuildConfig = {
    applicationRoot: "apps/web",
    builder: "dockerfile",
    dockerfilePath: "Dockerfile",
    buildCommand: "npm run build",
    startCommand: null,
    outputDirectory: "dist",
  };

  test("fetchBuildConfig uses the project-scoped GET route", async () => {
    mockFetchOnce({ config: null, updatedAt: null });
    const out = await fetchBuildConfig("p1");
    expect(out).toEqual({ config: null, updatedAt: null });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/build-config", {
      credentials: "include",
      signal: undefined,
    });
  });

  test("saveBuildConfig PUTs the exact schema body", async () => {
    mockFetchOnce({ config, updatedAt: "2026-10-23T00:00:00.000Z" });
    await saveBuildConfig("p1", config);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/build-config");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(config);
  });

  test("resetBuildConfig DELETEs the project-scoped route", async () => {
    mockFetchOnce({ config: null });
    await resetBuildConfig("p1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/build-config", {
      method: "DELETE",
      credentials: "include",
    });
  });

  test("detectProject POSTs to the project-scoped route", async () => {
    mockFetchOnce({
      status: "unsupported",
      commitSha: "abcdef1",
      detected: null,
      ambiguous: null,
      unsupported: { code: "NO_STACK", message: "No supported stack detected." },
      explicit: null,
      effective: null,
      explicitIssues: [],
    });
    const out = await detectProject("p1");
    expect(out.status).toBe("unsupported");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/detect", {
      method: "POST",
      credentials: "include",
      signal: undefined,
    });
  });

  test("build configuration errors preserve status and backend code", async () => {
    mockFetchOnce(
      { error: "Repository could not be checked out", code: "GIT_TIMEOUT" },
      false,
      504
    );
    const err = await detectProject("p1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(504);
    expect((err as ApiError).code).toBe("GIT_TIMEOUT");
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

describe("incident api client (HTTP boundary only)", () => {
  test("fetchIncidents hits the real route with the status filter", async () => {
    mockFetchOnce([]);
    await fetchIncidents("p1", { status: "active", limit: 100 });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/incidents?status=active&limit=100");
    expect(init.credentials).toBe("include");
  });

  test("fetchIncidents omits the query string when no filters are set", async () => {
    mockFetchOnce([]);
    await fetchIncidents("p1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/incidents");
  });

  test("fetchIncident returns the single incident row", async () => {
    const row = { id: "i1", status: "open", kind: "tls_failure" };
    mockFetchOnce(row);
    const out = await fetchIncident("p1", "i1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/incidents/i1", {
      credentials: "include",
      signal: undefined,
    });
    expect(out).toEqual(row);
  });

  test("acknowledgeIncident and resolveIncident POST to the real routes", async () => {
    mockFetchOnce({ id: "i1", status: "acknowledged" });
    await acknowledgeIncident("p1", "i1");
    let [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/incidents/i1/acknowledge");
    expect(init.method).toBe("POST");

    mockFetchOnce({ id: "i1", status: "resolved" });
    await resolveIncident("p1", "i1");
    [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/projects/p1/incidents/i1/resolve");
    expect(init.method).toBe("POST");
  });

  test("a 409 from a guarded transition surfaces as ApiError with status", async () => {
    mockFetchOnce({ error: "Incident is already resolved" }, false, 409);
    const err = await resolveIncident("p1", "i9").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as Error).message).toBe("Incident is already resolved");
  });
});
