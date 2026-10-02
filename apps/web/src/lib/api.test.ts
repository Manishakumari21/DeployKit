import { beforeEach, describe, expect, test, vi } from "vitest";
import { cancelDeployment, createDeployment, fetchDeployment, fetchDeploymentEvents, fetchDeployments } from "./api";
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
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/p1/deployments", undefined);
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
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d3", { signal: undefined });
    mockFetchOnce([]);
    await fetchDeploymentEvents("d3");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d3/events", undefined);
  });

  test("cancelDeployment posts to the real route", async () => {
    mockFetchOnce({ id: "d4", status: "cancelled" });
    await cancelDeployment("d4");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deployments/d4/cancel", { method: "POST" });
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
