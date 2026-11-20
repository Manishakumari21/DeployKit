// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeploymentLogs } from "./useDeploymentLogs";
import * as api from "../lib/api";
import type { ApiDeployment } from "../types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchDeployment: vi.fn(),
    fetchDeploymentLogs: vi.fn(),
  };
});

describe("useDeploymentLogs lifecycle and polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("stops polling after loading logs for a terminal (active) deployment", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchLogsMock = vi.mocked(api.fetchDeploymentLogs);

    fetchDepMock.mockResolvedValue({
      id: "dep-done",
      project_id: "p1",
      status: "active",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    fetchLogsMock.mockResolvedValueOnce({
      items: [
        {
          id: "log-1",
          deployment_id: "dep-done",
          source: "build",
          level: "info",
          message: "Build complete",
          metadata: {},
          created_at: "2026-01-01T00:00:01Z",
        },
      ],
      next_cursor: null,
      truncated: false,
    });

    const { result } = renderHook(() => useDeploymentLogs("dep-done"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchDepMock).toHaveBeenCalledTimes(1);
    expect(fetchLogsMock).toHaveBeenCalledTimes(1);
    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0].message).toBe("Build complete");

    // Advance timer: no polling because deployment is terminal and logs < 200
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(1);
  });

  test("preserves live polling while deployment is building and stops when terminal", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchLogsMock = vi.mocked(api.fetchDeploymentLogs);

    // 1st tick: deployment is building
    fetchDepMock.mockResolvedValueOnce({
      id: "dep-live",
      project_id: "p1",
      status: "building",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    fetchLogsMock.mockResolvedValueOnce({
      items: [
        {
          id: "log-1",
          deployment_id: "dep-live",
          source: "build",
          level: "info",
          message: "Step 1: Cloning repo",
          metadata: {},
          created_at: "2026-01-01T00:00:01Z",
        },
      ],
      next_cursor: "log-1",
      truncated: false,
    });

    // 2nd tick: deployment finished (active)
    fetchDepMock.mockResolvedValueOnce({
      id: "dep-live",
      project_id: "p1",
      status: "active",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
    } as ApiDeployment);

    fetchLogsMock.mockResolvedValueOnce({
      items: [
        {
          id: "log-2",
          deployment_id: "dep-live",
          source: "build",
          level: "info",
          message: "Step 2: Container launched",
          metadata: {},
          created_at: "2026-01-01T00:00:05Z",
        },
      ],
      next_cursor: null,
      truncated: false,
    });

    const { result } = renderHook(() => useDeploymentLogs("dep-live"));

    // 1st tick
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(1);
    expect(result.current.logs).toHaveLength(1);

    // Advance 3000ms: 2nd tick fires
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(2);
    expect(result.current.logs).toHaveLength(2);

    // Advance again by 6000ms: no more polling because status is now active
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(2);
  });

  test("cleans up timer and aborts on unmount", async () => {
    const fetchDepMock = vi.mocked(api.fetchDeployment);
    const fetchLogsMock = vi.mocked(api.fetchDeploymentLogs);

    fetchDepMock.mockResolvedValue({
      id: "dep-live",
      project_id: "p1",
      status: "building",
      trigger: "manual",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    } as ApiDeployment);

    fetchLogsMock.mockResolvedValue({
      items: [],
      next_cursor: null,
      truncated: false,
    });

    const { unmount } = renderHook(() => useDeploymentLogs("dep-live"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(fetchLogsMock).toHaveBeenCalledTimes(1);
  });
});
