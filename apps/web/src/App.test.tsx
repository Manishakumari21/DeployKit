// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import App from "./App";
import { useAuth } from "./hooks/useAuth";
import { detectProject, fetchBuildConfig, fetchProjectMetrics } from "./lib/api";
import type { ProjectMetrics } from "./lib/api";
import type { BuildConfig, DetectionResponse } from "./lib/buildConfig";
import type { AuthUser } from "./types";

const fixtures = vi.hoisted(() => ({
  project: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web",
    repository_url: "https://github.com/acme/web.git",
    branch: "main",
    created_at: "2026-10-20T00:00:00.000Z",
  },
}));

vi.mock("./hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("./hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [fixtures.project],
    healthy: true,
    loading: false,
    refreshing: false,
    load: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
  }),
  useToast: () => ({ toast: null, setToast: vi.fn() }),
}));

vi.mock("./hooks/useDeployments", () => ({
  useDeployments: () => ({
    deployments: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    creating: false,
    createError: null,
    create: vi.fn(),
    cancel: vi.fn(),
    setDeployments: vi.fn(),
  }),
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    fetchProjectMetrics: vi.fn(),
    fetchBuildConfig: vi.fn(),
    saveBuildConfig: vi.fn(),
    resetBuildConfig: vi.fn(),
    detectProject: vi.fn(),
  };
});

const authMock = vi.mocked(useAuth);
const fetchBuildConfigMock = vi.mocked(fetchBuildConfig);
const fetchProjectMetricsMock = vi.mocked(fetchProjectMetrics);
const detectProjectMock = vi.mocked(detectProject);

const user: AuthUser = {
  id: "user-1",
  email: "dev@example.com",
  created_at: "2026-10-20T00:00:00.000Z",
  updated_at: "2026-10-20T00:00:00.000Z",
};

const authenticated: ReturnType<typeof useAuth> = {
  status: "authenticated",
  user,
  busy: false,
  error: null,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
};

const savedConfig: BuildConfig = {
  applicationRoot: "apps/web",
  builder: "dockerfile",
  dockerfilePath: "Dockerfile",
  buildCommand: "npm run build",
  startCommand: null,
  outputDirectory: "dist",
};

const metrics: ProjectMetrics = {
  project_id: fixtures.project.id,
  deployments: {
    total: 0,
    successful: 0,
    failed: 0,
    cancelled: 0,
    success_rate: null,
    avg_duration_seconds: null,
    build_count: 0,
    build_failures: 0,
    avg_build_duration_seconds: null,
  },
  queue: { queued: 0, running: 0, failed: 0, succeeded: 0, total_retries: 0 },
  runtime: { active_releases: 0, healthy_runtimes: 0, unhealthy_runtimes: 0 },
  worker: { enabled: false, poll_interval_ms: 0, lease_ms: 0, last_activity_at: null },
};

function detection(): DetectionResponse {
  return {
    status: "detected",
    commitSha: "abcdef1234567890",
    detected: {
      config: {
        applicationRoot: ".",
        builder: "node",
        dockerfilePath: null,
        buildCommand: "npm run build:detected",
        startCommand: "npm start",
        outputDirectory: "dist",
      },
      language: "node",
      framework: "vite",
      confidence: "high",
      needsReview: false,
      evidence: [
        { file: "package.json", fact: "scripts.build is vite build", type: "manifest" },
      ],
      suggestions: [
        {
          field: "outputDirectory",
          value: "build",
          basis: "vite config outDir",
          confidence: "medium",
        },
      ],
    },
    ambiguous: null,
    unsupported: null,
    explicit: savedConfig,
    effective: {
      ...savedConfig,
      sources: {
        applicationRoot: "explicit",
        builder: "explicit",
        dockerfilePath: "explicit",
        buildCommand: "explicit",
        startCommand: "explicit",
        outputDirectory: "explicit",
      },
    },
    explicitIssues: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  authMock.mockReturnValue(authenticated);
  fetchBuildConfigMock.mockResolvedValue({
    config: savedConfig,
    updatedAt: "2026-10-23T00:00:00.000Z",
  });
  fetchProjectMetricsMock.mockResolvedValue(metrics);
  detectProjectMock.mockResolvedValue(detection());
});

afterEach(() => {
  cleanup();
});

describe("project build configuration navigation", () => {
  test("opens build configuration from the primary project navigation and wires detection", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "web" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Build config" }));

    expect(await screen.findByRole("heading", { name: "Build & detection" })).toBeTruthy();
    expect(await screen.findByDisplayValue("apps/web")).toBeTruthy();
    expect(fetchBuildConfigMock).toHaveBeenCalledWith(
      fixtures.project.id,
      expect.any(AbortSignal)
    );

    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));

    expect(await screen.findByText("high confidence")).toBeTruthy();
    expect(screen.getByText("Evidence (observed)")).toBeTruthy();
    expect(screen.getByText("Suggestions (not applied)")).toBeTruthy();
    expect(detectProjectMock).toHaveBeenCalledWith(
      fixtures.project.id,
      expect.any(AbortSignal)
    );
  });

  test("opens build configuration from the selected service header", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open build configuration" }));

    expect(await screen.findByRole("heading", { name: "Build & detection" })).toBeTruthy();
    expect(await screen.findByDisplayValue("apps/web")).toBeTruthy();
  });

  test("does not expose build configuration without authentication", () => {
    authMock.mockReturnValue({
      ...authenticated,
      status: "unauthenticated" as const,
      user: null,
    });

    render(<App />);

    expect(screen.queryByRole("button", { name: "Build config" })).toBeNull();
    expect(screen.queryByText("Build & detection")).toBeNull();
  });
});
