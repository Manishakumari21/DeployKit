// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EventsView } from "./EventsView";
import { fetchProjectEvents } from "../lib/api";
import type { Project, ProjectEvent } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchProjectEvents: vi.fn(),
  };
});

const fetchEventsMock = vi.mocked(fetchProjectEvents);

const projects: Project[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web",
    repository_url: "https://github.com/acme/web.git",
    branch: "main",
    created_at: "2026-10-20T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "api",
    repository_url: "https://github.com/acme/api.git",
    branch: "main",
    created_at: "2026-10-19T00:00:00.000Z",
  },
];

const activeEvent: ProjectEvent = {
  id: "9",
  deployment_id: "33333333-3333-4333-8333-333333333333",
  event_type: "deployment.active",
  status_from: "verifying",
  status_to: "active",
  message: "Deployment active",
  metadata: {},
  created_at: new Date().toISOString(),
  branch: "main",
  commit_sha: "abcdef1234567890",
  trigger: "manual",
};

const failedEvent: ProjectEvent = {
  ...activeEvent,
  id: "10",
  event_type: "deployment.failed",
  status_from: "building",
  status_to: "failed",
  message: "Deployment failed",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("EventsView", () => {
  test("loads events for the selected service", async () => {
    fetchEventsMock.mockResolvedValue([activeEvent]);

    render(
      <EventsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("Deployment active")).toBeTruthy();
    expect(fetchEventsMock).toHaveBeenCalledWith(projects[0].id, 50);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  test("switches services and reloads the event stream", async () => {
    fetchEventsMock.mockImplementation(async (projectId) =>
      projectId === projects[0].id ? [activeEvent] : [failedEvent]
    );
    const onSelectProject = vi.fn();

    const { rerender } = render(
      <EventsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={onSelectProject}
      />
    );

    await screen.findByText("Deployment active");
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: projects[1].id },
    });

    expect(onSelectProject).toHaveBeenCalledWith(projects[1].id);

    rerender(
      <EventsView
        projects={projects}
        selectedProjectId={projects[1].id}
        onSelectProject={onSelectProject}
      />
    );

    expect(await screen.findByText("Deployment failed")).toBeTruthy();
    expect(fetchEventsMock).toHaveBeenCalledWith(projects[1].id, 50);
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  test("shows an empty state when a service has no events", async () => {
    fetchEventsMock.mockResolvedValue([]);

    render(
      <EventsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("No events yet")).toBeTruthy();
  });

  test("shows a load error and retries", async () => {
    fetchEventsMock
      .mockRejectedValueOnce(new Error("Events unavailable"))
      .mockResolvedValueOnce([activeEvent]);

    render(
      <EventsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("Events unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Deployment active")).toBeTruthy();
    expect(fetchEventsMock).toHaveBeenCalledTimes(2);
  });
});
