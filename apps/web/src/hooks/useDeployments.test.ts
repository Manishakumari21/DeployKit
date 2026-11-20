// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeploymentMonitor } from "./useDeployments";
import * as api from "../lib/api";
import type { ApiDeployment } from "../types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchDeployment: vi.fn(),
    fetchDeploymentEvents: vi.fn(),
  };
});

describe("useDeploymentMonitor polling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("stops polling after active (terminal) status is reached", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchEventsMock = vi.mocked(api.fetchDeploymentEvents);

    fetchEventsMock.mockResolvedValue([]);

    fetchDepMock.mockResolvedValueOnce({
      id: "dep-1",
      project_id: "p1",
      status: "building",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    fetchDepMock.mockResolvedValueOnce({
      id: "dep-1",
      project_id: "p1",
      status: "active",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:02Z",
    } as ApiDeployment);

    const { result } = renderHook(() => useDeploymentMonitor("dep-1"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
    expect(result.current.deployment?.status).toBe("building");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(2);
    expect(result.current.deployment?.status).toBe("active");

    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(2);
  });

  test("stops polling after failed (terminal) status is reached", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchEventsMock = vi.mocked(api.fetchDeploymentEvents);

    fetchEventsMock.mockResolvedValue([]);

    fetchDepMock.mockResolvedValueOnce({
      id: "dep-fail",
      project_id: "p1",
      status: "failed",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    const { result } = renderHook(() => useDeploymentMonitor("dep-fail"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
    expect(result.current.deployment?.status).toBe("failed");

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
  });

  test("stops polling after cancelled (terminal) status is reached", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchEventsMock = vi.mocked(api.fetchDeploymentEvents);

    fetchEventsMock.mockResolvedValue([]);

    fetchDepMock.mockResolvedValueOnce({
      id: "dep-cancel",
      project_id: "p1",
      status: "cancelled",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    const { result } = renderHook(() => useDeploymentMonitor("dep-cancel"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
    expect(result.current.deployment?.status).toBe("cancelled");

    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
  });

  test("cleans up timers and aborts fetch on unmount", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchEventsMock = vi.mocked(api.fetchDeploymentEvents);

    fetchEventsMock.mockResolvedValue([]);

    fetchDepMock.mockResolvedValue({
      id: "dep-live",
      project_id: "p1",
      status: "building",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    const { unmount } = renderHook(() => useDeploymentMonitor("dep-live"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
  });

  test("prevents stale in-flight requests from updating state after deploymentId changes", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchEventsMock = vi.mocked(api.fetchDeploymentEvents);

    fetchEventsMock.mockResolvedValue([]);

    let resolveDep1!: (val: ApiDeployment) => void;
    const dep1Promise = new Promise<ApiDeployment>((resolve) => {
      resolveDep1 = resolve;
    });

    fetchDepMock.mockImplementation((id: string) => {
      if (id === "dep-1") return dep1Promise;
      return Promise.resolve({
        id: "dep-2",
        project_id: "p1",
        status: "active",
        trigger: "manual",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:02Z",
      } as ApiDeployment);
    });

    const { result, rerender } = renderHook(
      ({ id }) => useDeploymentMonitor(id),
      { initialProps: { id: "dep-1" } }
    );

    expect(fetchDepMock).toHaveBeenCalledWith("dep-1", expect.any(AbortSignal));

    rerender({ id: "dep-2" });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.deployment?.id).toBe("dep-2");

    await act(async () => {
      resolveDep1({
        id: "dep-1",
        project_id: "p1",
        status: "building",
        trigger: "manual",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
      } as ApiDeployment);
      await Promise.resolve();
    });

    expect(result.current.deployment?.id).toBe("dep-2");
  });
});
