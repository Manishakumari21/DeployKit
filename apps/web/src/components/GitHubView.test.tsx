// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { GitHubView } from "./GitHubView";
import {
  ApiError,
  fetchGitHubConnection,
  fetchGitHubRepositories,
  fetchProjectGithubLink,
  linkProjectGithub,
  unlinkProjectGithub,
} from "../lib/api";
import type { GitHubConnection, GitHubLink, GitHubRepository, Project } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchGitHubConnection: vi.fn(),
    fetchGitHubRepositories: vi.fn(),
    fetchProjectGithubLink: vi.fn(),
    linkProjectGithub: vi.fn(),
    unlinkProjectGithub: vi.fn(),
  };
});

const fetchConnectionMock = vi.mocked(fetchGitHubConnection);
const fetchRepositoriesMock = vi.mocked(fetchGitHubRepositories);
const fetchProjectGithubLinkMock = vi.mocked(fetchProjectGithubLink);
const linkProjectGithubMock = vi.mocked(linkProjectGithub);
const unlinkProjectGithubMock = vi.mocked(unlinkProjectGithub);

const projects: Project[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web-app",
    repository_url: "https://github.com/acme/web-app.git",
    branch: "main",
    created_at: "2026-10-20T00:00:00.000Z",
  },
];

const connectedState: GitHubConnection = {
  configured: true,
  installUrl: "https://github.com/apps/deploykit/installations/new",
  callbackUrl: "https://api.deploykit.local/api/github/callback",
  error: null,
};

const unconfiguredState: GitHubConnection = {
  configured: false,
  installUrl: null,
  callbackUrl: "https://api.deploykit.local/api/github/callback",
  error: "Set the GitHub App credentials on the server before connecting.",
};

const sampleRepos: GitHubRepository[] = [
  {
    id: 101,
    name: "backend-service",
    fullName: "acme/backend-service",
    owner: "acme",
    private: true,
    htmlUrl: "https://github.com/acme/backend-service",
    cloneUrl: "https://github.com/acme/backend-service.git",
    defaultBranch: "main",
    installationId: "inst_123",
  },
  {
    id: 102,
    name: "frontend-service",
    fullName: "acme/frontend-service",
    owner: "acme",
    private: false,
    htmlUrl: "https://github.com/acme/frontend-service",
    cloneUrl: "https://github.com/acme/frontend-service.git",
    defaultBranch: "production",
    installationId: "inst_123",
  },
];

const unlinkedProjectLink: GitHubLink = {
  project_id: projects[0].id,
  linked: false,
};

const linkedProjectLink: GitHubLink = {
  project_id: projects[0].id,
  linked: true,
  auto_deploy: true,
  branch: "main",
  repository_id: "101",
  full_name: "acme/backend-service",
  private: true,
  installation_id: "inst_123",
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchConnectionMock.mockResolvedValue(connectedState);
  fetchRepositoriesMock.mockResolvedValue({
    repositories: sampleRepos,
    truncated: false,
    failed: 0,
  });
  fetchProjectGithubLinkMock.mockResolvedValue(unlinkedProjectLink);
  linkProjectGithubMock.mockResolvedValue({ success: true });
  unlinkProjectGithubMock.mockResolvedValue({ unlinked: true });
});

afterEach(() => {
  cleanup();
});

describe("GitHubView", () => {
  test("mounts successfully and renders the connected state", async () => {
    render(<GitHubView projects={projects} />);

    expect(await screen.findByText("GitHub App installed")).toBeTruthy();
    expect(screen.getByText(/callback https:\/\/api\.deploykit\.local/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect GitHub App/i })).toBeTruthy();

    const reposHead = screen.getByText("Repositories");
    const reposPanel = reposHead.closest(".dk-panel")!;
    expect(within(reposPanel as HTMLElement).getByText("acme/backend-service")).toBeTruthy();
    expect(within(reposPanel as HTMLElement).getByText("acme/frontend-service")).toBeTruthy();
  });

  test("renders unconfigured state when GitHub App is not configured on server", async () => {
    fetchConnectionMock.mockResolvedValue(unconfiguredState);
    fetchRepositoriesMock.mockRejectedValue(
      new ApiError("GitHub is not configured", 503, "GITHUB_NOT_CONFIGURED")
    );

    render(<GitHubView projects={projects} />);

    expect((await screen.findAllByText("GitHub is not configured")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Set the GitHub App credentials on the server before connecting.")
    ).toBeTruthy();
    expect(screen.queryByText("GitHub App installed")).toBeNull();
  });

  test("connect action launches popup with backend-provided URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<GitHubView projects={projects} />);

    const connectBtn = await screen.findByRole("button", { name: /Connect GitHub App/i });
    fireEvent.click(connectBtn);

    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/apps/deploykit/installations/new",
      "deploykit-github",
      "width=720,height=760"
    );
    openSpy.mockRestore();
  });

  test("renders repository list with visibility and branch", async () => {
    render(<GitHubView projects={projects} />);

    await screen.findByText("GitHub App installed");
    const reposPanel = screen.getByText("Repositories").closest(".dk-panel")!;
    const panelWithin = within(reposPanel as HTMLElement);

    expect(panelWithin.getByText("acme/backend-service")).toBeTruthy();
    expect(panelWithin.getByText("private")).toBeTruthy();
    expect(panelWithin.getByText(/production/)).toBeTruthy();
    expect(panelWithin.getByText("public")).toBeTruthy();
  });

  test("repository search filters repositories by name or owner", async () => {
    render(<GitHubView projects={projects} />);

    await screen.findByText("GitHub App installed");
    const reposPanel = screen.getByText("Repositories").closest(".dk-panel")!;
    const panelWithin = within(reposPanel as HTMLElement);

    expect(panelWithin.getByText("acme/backend-service")).toBeTruthy();
    const filterInput = screen.getByLabelText("Filter repositories");

    fireEvent.change(filterInput, { target: { value: "frontend" } });

    expect(panelWithin.queryByText("acme/backend-service")).toBeNull();
    expect(panelWithin.getByText("acme/frontend-service")).toBeTruthy();

    fireEvent.change(filterInput, { target: { value: "nonexistent" } });
    expect(panelWithin.getByText("No repositories match")).toBeTruthy();
  });

  test("empty repository state renders when no repositories are installed", async () => {
    fetchRepositoriesMock.mockResolvedValue({
      repositories: [],
      truncated: false,
      failed: 0,
    });

    render(<GitHubView projects={projects} />);

    expect(await screen.findByText("No installed repositories")).toBeTruthy();
    expect(
      screen.getByText("Install the GitHub App on at least one repository to see it here.")
    ).toBeTruthy();
  });

  test("links a repository to a project and triggers notifications and updates", async () => {
    const onNotify = vi.fn();
    const onProjectUpdate = vi.fn();

    render(
      <GitHubView
        projects={projects}
        onNotify={onNotify}
        onProjectUpdate={onProjectUpdate}
      />
    );

    const select = await screen.findByLabelText(`Repository for ${projects[0].name}`);
    fireEvent.change(select, { target: { value: "101" } });

    const linkBtn = screen.getByRole("button", { name: "Link" });
    fireEvent.click(linkBtn);

    await waitFor(() => {
      expect(linkProjectGithubMock).toHaveBeenCalledWith(projects[0].id, {
        installationId: "inst_123",
        repositoryFullName: "acme/backend-service",
        repositoryId: 101,
        autoDeploy: true,
      });
      expect(onNotify).toHaveBeenCalledWith("web-app linked to acme/backend-service");
      expect(onProjectUpdate).toHaveBeenCalled();
    });
  });

  test("unlink action opens confirmation dialog and executes unlinking on confirm", async () => {
    fetchProjectGithubLinkMock.mockResolvedValue(linkedProjectLink);
    const onNotify = vi.fn();
    const onProjectUpdate = vi.fn();

    render(
      <GitHubView
        projects={projects}
        onNotify={onNotify}
        onProjectUpdate={onProjectUpdate}
      />
    );

    const unlinkBtn = await screen.findByRole("button", { name: "Unlink" });
    fireEvent.click(unlinkBtn);

    // Confirmation modal should appear
    expect(screen.getByRole("heading", { name: "Unlink repository?" })).toBeTruthy();
    expect(
      screen.getByText(/Are you sure you want to unlink/)
    ).toBeTruthy();

    // Clicking Cancel should close the dialog without calling API
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole("heading", { name: "Unlink repository?" })).toBeNull();
    expect(unlinkProjectGithubMock).not.toHaveBeenCalled();

    // Clicking Unlink again and then confirming
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    const confirmBtn = screen.getByRole("button", { name: "Confirm Unlink" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(unlinkProjectGithubMock).toHaveBeenCalledWith(projects[0].id);
      expect(onNotify).toHaveBeenCalledWith("web-app unlinked");
      expect(onProjectUpdate).toHaveBeenCalled();
    });
  });

  test("auto-deploy button toggles auto-deploy setting", async () => {
    fetchProjectGithubLinkMock.mockResolvedValue(linkedProjectLink);
    const onNotify = vi.fn();
    const onProjectUpdate = vi.fn();

    render(
      <GitHubView
        projects={projects}
        onNotify={onNotify}
        onProjectUpdate={onProjectUpdate}
      />
    );

    const toggleBtn = await screen.findByRole("button", {
      name: `Toggle auto-deploy for ${projects[0].name}`,
    });
    expect(screen.getByText("auto-deploy on")).toBeTruthy();

    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(linkProjectGithubMock).toHaveBeenCalledWith(projects[0].id, {
        installationId: "inst_123",
        repositoryFullName: "acme/backend-service",
        repositoryId: 101,
        autoDeploy: false,
      });
      expect(onNotify).toHaveBeenCalledWith("Auto-deploy disabled for web-app");
      expect(onProjectUpdate).toHaveBeenCalled();
    });
  });

  test("displays useful error when fetching connection fails", async () => {
    fetchConnectionMock.mockRejectedValue(new Error("Network connection lost"));

    render(<GitHubView projects={projects} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Network connection lost")).toBeTruthy();
  });
});
