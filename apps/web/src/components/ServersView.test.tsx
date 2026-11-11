// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ServersView } from "./ServersView";
import {
  enrollProjectAgent,
  fetchProjectAgents,
  revokeProjectAgent,
} from "../lib/api";
import type { Project, ProjectAgent } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchProjectAgents: vi.fn(),
    enrollProjectAgent: vi.fn(),
    revokeProjectAgent: vi.fn(),
  };
});

const fetchProjectAgentsMock = vi.mocked(fetchProjectAgents);
const enrollProjectAgentMock = vi.mocked(enrollProjectAgent);
const revokeProjectAgentMock = vi.mocked(revokeProjectAgent);

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "api-service",
  repository_url: "https://github.com/acme/api.git",
  branch: "main",
  created_at: "2026-10-20T00:00:00.000Z",
};

const sampleAgents: ProjectAgent[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    name: "us-east-metal1",
    status: "online",
    lastHeartbeatAt: new Date().toISOString(),
    version: "1.0.0",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
];

describe("ServersView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchProjectAgentsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  test("renders empty state when no project is provided", () => {
    render(<ServersView />);
    expect(screen.getByText("No service selected")).toBeTruthy();
  });

  test("renders enrolled agents for the project", async () => {
    fetchProjectAgentsMock.mockResolvedValueOnce(sampleAgents);

    render(<ServersView project={project} />);

    expect(await screen.findByText("us-east-metal1")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
  });

  test("enrolling a new server generates credentials and command", async () => {
    fetchProjectAgentsMock.mockResolvedValueOnce([]);
    enrollProjectAgentMock.mockResolvedValueOnce({
      agent: {
        id: "33333333-3333-4333-8333-333333333333",
        projectId: project.id,
        name: "eu-west-vps",
        status: "pending",
        lastHeartbeatAt: null,
        version: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      credential: {
        id: "cred-1",
        token: "dk_agent_token_secret_xyz123",
        expiresAt: null,
      },
      installCommand: "docker run -d --name dk-agent ...",
    });

    render(<ServersView project={project} />);

    expect(await screen.findByText("No remote servers connected")).toBeTruthy();

    const enrollBtn = screen.getByRole("button", { name: "Enroll Server" });
    fireEvent.click(enrollBtn);

    const input = screen.getByLabelText("Server / Node Name");
    fireEvent.change(input, { target: { value: "eu-west-vps" } });

    const submitBtn = screen.getByRole("button", { name: "Generate Credentials" });
    fireEvent.click(submitBtn);

    expect(await screen.findByText("Agent Token (Secret)")).toBeTruthy();
    expect(screen.getByDisplayValue("dk_agent_token_secret_xyz123")).toBeTruthy();
  });

  test("revoking an agent opens confirmation and calls revokeProjectAgent", async () => {
    fetchProjectAgentsMock.mockResolvedValueOnce(sampleAgents);
    revokeProjectAgentMock.mockResolvedValueOnce({
      message: "Agent credential revoked successfully",
    });

    render(<ServersView project={project} />);

    expect(await screen.findByText("us-east-metal1")).toBeTruthy();

    const revokeBtn = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(revokeBtn);

    expect(screen.getByText("Revoke Agent Credential")).toBeTruthy();

    const confirmBtn = screen.getByRole("button", { name: "Revoke Server" });
    fireEvent.click(confirmBtn);

    expect(revokeProjectAgentMock).toHaveBeenCalledWith(
      project.id,
      sampleAgents[0].id
    );
  });
});
