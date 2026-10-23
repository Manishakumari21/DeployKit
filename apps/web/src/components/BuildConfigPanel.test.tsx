// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { BuildConfigPanel } from "./BuildConfigPanel";
import {
  ApiError,
  detectProject,
  fetchBuildConfig,
  resetBuildConfig,
  saveBuildConfig,
} from "../lib/api";
import type {
  BuildConfig,
  BuildConfigResponse,
  DetectionResponse,
  EffectiveBuildConfig,
} from "../lib/buildConfig";
import type { Project } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchBuildConfig: vi.fn(),
    saveBuildConfig: vi.fn(),
    resetBuildConfig: vi.fn(),
    detectProject: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchBuildConfig);
const saveMock = vi.mocked(saveBuildConfig);
const resetMock = vi.mocked(resetBuildConfig);
const detectMock = vi.mocked(detectProject);

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "web",
  repository_url: "https://github.com/acme/web.git",
  branch: "main",
  created_at: "2026-10-20T00:00:00.000Z",
};

const updatedAt = "2026-10-23T00:00:00.000Z";

const savedConfig: BuildConfig = {
  applicationRoot: "apps/web",
  builder: "dockerfile",
  dockerfilePath: "Dockerfile",
  buildCommand: "npm run build",
  startCommand: null,
  outputDirectory: "dist",
};

const effective: EffectiveBuildConfig = {
  ...savedConfig,
  sources: {
    applicationRoot: "explicit",
    builder: "explicit",
    dockerfilePath: "explicit",
    buildCommand: "explicit",
    startCommand: "explicit",
    outputDirectory: "explicit",
  },
};

function detection(overrides: Partial<DetectionResponse> = {}): DetectionResponse {
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
    effective,
    explicitIssues: [],
    ...overrides,
  };
}

async function renderLoaded() {
  render(<BuildConfigPanel project={project} />);
  await screen.findByDisplayValue("apps/web");
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ config: savedConfig, updatedAt });
  saveMock.mockResolvedValue({ config: savedConfig, updatedAt });
  resetMock.mockResolvedValue({ config: null });
  detectMock.mockResolvedValue(detection());
});

afterEach(() => {
  cleanup();
});

describe("BuildConfigPanel", () => {
  test("shows a loading state while configuration loads", async () => {
    fetchMock.mockReturnValue(new Promise<BuildConfigResponse>(() => {}));
    render(<BuildConfigPanel project={project} />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Loading build configuration");
  });

  test("loads and displays the saved configuration", async () => {
    await renderLoaded();
    expect((screen.getByLabelText("Builder") as HTMLSelectElement).value).toBe("dockerfile");
    expect((screen.getByLabelText("Dockerfile path") as HTMLInputElement).value).toBe("Dockerfile");
    expect((screen.getByLabelText("Build command") as HTMLInputElement).value).toBe(
      "npm run build"
    );
    expect((screen.getByLabelText("Start command") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Output directory") as HTMLInputElement).value).toBe("dist");
    expect(screen.getByText("saved override")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(project.id, expect.any(AbortSignal));
  });

  test("shows an empty state when no configuration is saved", async () => {
    fetchMock.mockResolvedValue({ config: null, updatedAt: null });
    render(<BuildConfigPanel project={project} />);
    expect(await screen.findByText(/No saved configuration/)).toBeTruthy();
    expect(screen.getByText("automatic detection")).toBeTruthy();
    expect((screen.getByLabelText("Builder") as HTMLSelectElement).value).toBe("");
  });

  test("shows a clear authorization error when loading is forbidden", async () => {
    fetchMock.mockRejectedValue(new ApiError("Forbidden", 403));
    render(<BuildConfigPanel project={project} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You do not have access to this service.");
    expect(screen.queryByLabelText("Build command")).toBeNull();
  });

  test("renders detection facts, confidence, evidence, and suggestions", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    expect(await screen.findByText("high confidence")).toBeTruthy();
    expect(screen.getByText("Detected configuration")).toBeTruthy();
    expect(screen.getByText("Evidence (observed)")).toBeTruthy();
    expect(screen.getByText("scripts.build is vite build")).toBeTruthy();
    expect(screen.getByText("Suggestions (not applied)")).toBeTruthy();
    expect(screen.getByText("vite config outDir")).toBeTruthy();
    expect(screen.getByText("Effective configuration")).toBeTruthy();
    expect(screen.getByText(/A saved configuration is active/)).toBeTruthy();
  });

  test("detection never silently replaces the saved configuration", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    await screen.findByText("high confidence");
    expect((screen.getByLabelText("Application root") as HTMLInputElement).value).toBe(
      "apps/web"
    );
    expect((screen.getByLabelText("Builder") as HTMLSelectElement).value).toBe("dockerfile");
    expect((screen.getByLabelText("Build command") as HTMLInputElement).value).toBe(
      "npm run build"
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  test("renders monorepo candidates without selecting one automatically", async () => {
    fetchMock.mockResolvedValue({
      config: { ...savedConfig, applicationRoot: "." },
      updatedAt,
    });
    detectMock.mockResolvedValue(
      detection({
        status: "ambiguous",
        detected: null,
        ambiguous: {
          code: "PREFLIGHT_NEEDS_CONFIG",
          message: "Multiple application roots found",
          candidates: ["apps/web", "services/api"],
        },
        effective: null,
      })
    );
    render(<BuildConfigPanel project={project} />);
    await screen.findByDisplayValue(".");
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    expect(await screen.findByText("Monorepo candidates")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Monorepo candidates" });
    expect(within(list).getByText("apps/web")).toBeTruthy();
    expect(within(list).getByText("services/api")).toBeTruthy();
    expect(screen.getByText(/No root was selected automatically/)).toBeTruthy();
    expect((screen.getByLabelText("Application root") as HTMLInputElement).value).toBe(".");

    fireEvent.click(
      within(list).getAllByRole("button", { name: "Use as application root" })[1]
    );
    expect((screen.getByLabelText("Application root") as HTMLInputElement).value).toBe(
      "services/api"
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  test("shows a detection error and retries", async () => {
    detectMock
      .mockRejectedValueOnce(new ApiError("Repository could not be checked out", 502, "GIT_CLONE_FAILED"))
      .mockResolvedValueOnce(detection());
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The repository could not be reached (GIT_CLONE_FAILED).");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("high confidence")).toBeTruthy();
  });

  test("renders an unsupported detection result", async () => {
    detectMock.mockResolvedValue(
      detection({
        status: "unsupported",
        detected: null,
        unsupported: {
          code: "NO_RECOGNIZED_STACK",
          message: "No supported stack detected.",
        },
        explicit: null,
        effective: null,
      })
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    expect(await screen.findByText("No supported stack detected.")).toBeTruthy();
    expect(screen.getByText("NO_RECOGNIZED_STACK")).toBeTruthy();
  });

  test("renders saved configuration issues without changing them", async () => {
    detectMock.mockResolvedValue(
      detection({
        explicitIssues: ["SYMLINK_NOT_ALLOWED: Path must not traverse symbolic links"],
      })
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    expect(await screen.findByText(/Saved configuration issues at this commit/)).toBeTruthy();
    expect(screen.getByText(/SYMLINK_NOT_ALLOWED/)).toBeTruthy();
    expect((screen.getByLabelText("Application root") as HTMLInputElement).value).toBe(
      "apps/web"
    );
  });

  test("edits and saves configuration, then refreshes from the server", async () => {
    const updated = { ...savedConfig, buildCommand: "npm run build:prod" };
    fetchMock
      .mockResolvedValueOnce({ config: savedConfig, updatedAt })
      .mockResolvedValueOnce({ config: updated, updatedAt });
    saveMock.mockResolvedValue({ config: updated, updatedAt });
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Build command"), {
      target: { value: "npm run build:prod" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith(project.id, {
      ...savedConfig,
      buildCommand: "npm run build:prod",
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByLabelText("Build command") as HTMLInputElement).value).toBe(
        "npm run build:prod"
      )
    );
    expect(screen.getByText(/Build configuration saved/)).toBeTruthy();
  });

  test("shows field-level validation errors and does not call the API", async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Dockerfile path"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(
      screen.getByText("Dockerfile path is required for the Dockerfile builder.")
    ).toBeTruthy();
    expect(saveMock).not.toHaveBeenCalled();
  });

  test("maps a field-level API error and a generic API error", async () => {
    saveMock.mockRejectedValueOnce(
      new ApiError("dockerfilePath: required for the dockerfile builder", 400)
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("required for the dockerfile builder")).toBeTruthy();

    saveMock.mockRejectedValueOnce(new ApiError("Failed to process request", 500));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Could not save the build configuration.")).toBeTruthy();
  });

  test("resets to automatic detection only after confirmation and refreshes", async () => {
    fetchMock
      .mockResolvedValueOnce({ config: savedConfig, updatedAt })
      .mockResolvedValueOnce({ config: null, updatedAt: null });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic detection" }));
    expect(screen.getByRole("button", { name: "Confirm reset" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => expect(resetMock).toHaveBeenCalledWith(project.id));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Saved override removed/)).toBeTruthy();
    expect(screen.getByText(/No saved configuration/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to automatic detection" })).toBeNull();
  });

  test("detected settings and suggestions are copied only on explicit action", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Detect project settings" }));
    await screen.findByText("high confidence");

    fireEvent.click(screen.getByRole("button", { name: "Apply suggestion for outputDirectory" }));
    expect((screen.getByLabelText("Output directory") as HTMLInputElement).value).toBe("build");
    expect(saveMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use detected settings in editor" }));
    expect((screen.getByLabelText("Application root") as HTMLInputElement).value).toBe(".");
    expect((screen.getByLabelText("Builder") as HTMLSelectElement).value).toBe("node");
    expect((screen.getByLabelText("Dockerfile path") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Dockerfile path") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Build command") as HTMLInputElement).value).toBe(
      "npm run build:detected"
    );
    expect(saveMock).not.toHaveBeenCalled();
  });
});
