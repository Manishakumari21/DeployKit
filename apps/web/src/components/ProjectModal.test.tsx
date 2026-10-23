// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectModal } from "./ProjectModal";
import { ApiError, fetchGitHubConnection, fetchGitHubRepositories } from "../lib/api";
import type {
  GitHubConnection,
  GitHubRepositoriesResponse,
  GitHubRepository,
  GitHubSelection,
} from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchGitHubConnection: vi.fn(),
    fetchGitHubRepositories: vi.fn(),
  };
});

const connectionMock = vi.mocked(fetchGitHubConnection);
const repositoriesMock = vi.mocked(fetchGitHubRepositories);

const repository: GitHubRepository = {
  id: 42,
  fullName: "acme/website",
  name: "website",
  owner: "acme",
  private: false,
  htmlUrl: "https://github.com/acme/website",
  cloneUrl: "https://github.com/acme/website.git",
  defaultBranch: "main",
  installationId: "123",
};

const connection: GitHubConnection = {
  configured: true,
  installUrl: "https://github.com/apps/deploykit/installations/new?state=test",
  callbackUrl: "http://localhost:3001/api/github/callback",
  error: null,
};

const repositories: GitHubRepositoriesResponse = {
  repositories: [repository],
  truncated: false,
  failed: 0,
};

type Submit = (
  name: string,
  repo: string,
  branch: string,
  github?: GitHubSelection
) => Promise<boolean>;

function renderModal(onSubmit: Submit = vi.fn().mockResolvedValue(true)) {
  render(
    <ProjectModal
      open
      busy={false}
      error=""
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionMock.mockResolvedValue(connection);
  repositoriesMock.mockResolvedValue(repositories);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectModal GitHub repository picker", () => {
  test("chooses a repository and fills the service name, branch, and URL", async () => {
    const onSubmit = vi.fn<Submit>().mockResolvedValue(true);
    renderModal(onSubmit);

    const select = await screen.findByLabelText("Repository");
    fireEvent.change(select, { target: { value: "42" } });

    expect((screen.getByLabelText("Service name") as HTMLInputElement).value).toBe(
      "website"
    );
    expect((screen.getByLabelText("Branch") as HTMLInputElement).value).toBe("main");
    expect(screen.getByText("https://github.com/acme/website")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Commission service" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      "website",
      "https://github.com/acme/website",
      "main",
      {
        installationId: "123",
        repositoryFullName: "acme/website",
        repositoryId: 42,
      }
    );
  });

  test("falls back to a manual Git URL when GitHub is not configured", async () => {
    connectionMock.mockResolvedValue({
      configured: false,
      installUrl: null,
      callbackUrl: "http://localhost:3001/api/github/callback",
      error: "GitHub is not configured on this instance.",
    });
    const onSubmit = vi.fn<Submit>().mockResolvedValue(true);
    renderModal(onSubmit);

    expect(await screen.findByText("GitHub is not connected on this instance")).toBeTruthy();
    expect(repositoriesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Git URL" }));
    fireEvent.change(screen.getByLabelText("Service name"), {
      target: { value: "manual-site" },
    });
    fireEvent.change(screen.getByLabelText("Git URL"), {
      target: { value: "https://github.com/acme/manual.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commission service" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      "manual-site",
      "https://github.com/acme/manual.git",
      "main",
      undefined
    );
  });

  test("opens the GitHub App installation page from the connect action", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderModal();

    await screen.findByLabelText("Repository");
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(connection.installUrl, "_blank", "noopener,noreferrer")
    );
  });

  test("shows an empty repository state instead of an error when none are available", async () => {
    repositoriesMock.mockRejectedValue(
      new ApiError("Connect GitHub before choosing a repository.", 404, "GITHUB_NOT_CONNECTED")
    );
    renderModal();

    expect(await screen.findByText(/No repositories yet/)).toBeTruthy();
  });
});
