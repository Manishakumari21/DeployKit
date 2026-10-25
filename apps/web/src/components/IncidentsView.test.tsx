// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { IncidentsView } from "./IncidentsView";
import { ApiError, acknowledgeIncident, fetchIncidents, resolveIncident } from "../lib/api";
import type { Incident, Project } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchIncidents: vi.fn(),
    acknowledgeIncident: vi.fn(),
    resolveIncident: vi.fn(),
  };
});

const fetchIncidentsMock = vi.mocked(fetchIncidents);
const acknowledgeMock = vi.mocked(acknowledgeIncident);
const resolveMock = vi.mocked(resolveIncident);

const projects: Project[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web",
    repository_url: "https://github.com/acme/web.git",
    branch: "main",
    created_at: "2026-10-20T00:00:00.000Z",
  },
];

const openIncident: Incident = {
  id: "22222222-2222-4222-8222-222222222222",
  project_id: projects[0].id,
  kind: "deployment_failure",
  subject_key: "deployment:33333333-3333-4333-8333-333333333333",
  status: "open",
  severity: "warning",
  title: "Deployment failed on main",
  detail: "build failed during api test",
  error_code: "BUILD_FAILED",
  evidence: {},
  signal_token: "failed:33333333",
  source_timestamp: "2026-10-25T15:00:00.000Z",
  occurrence_count: 2,
  first_seen_at: "2026-10-25T15:00:00.000Z",
  last_seen_at: "2026-10-25T15:05:00.000Z",
  acknowledged_at: null,
  acknowledged_by: null,
  resolved_at: null,
  resolution: null,
  created_at: "2026-10-25T15:00:00.000Z",
  updated_at: "2026-10-25T15:05:00.000Z",
};

const acknowledgedIncident: Incident = {
  ...openIncident,
  id: "44444444-4444-4444-8444-444444444444",
  subject_key: "tls:55555555-5555-4555-8555-555555555555",
  kind: "tls_failure",
  severity: "critical",
  title: "TLS certificate expired for inc.example.com",
  error_code: "TLS_CERT_EXPIRED",
  status: "acknowledged",
  acknowledged_at: "2026-10-25T15:06:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("IncidentsView", () => {
  test("loads incidents for the selected service", async () => {
    fetchIncidentsMock.mockResolvedValue([openIncident]);

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("Deployment failed on main")).toBeTruthy();
    expect(fetchIncidentsMock).toHaveBeenCalledWith(
      projects[0].id,
      { status: "active", limit: 100 },
      expect.anything()
    );
    expect(screen.getByText(/BUILD_FAILED/)).toBeTruthy();
    expect(screen.getByText(/×2/)).toBeTruthy();
  });

  test("shows the empty state when there are no incidents", async () => {
    fetchIncidentsMock.mockResolvedValue([]);

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("No incidents")).toBeTruthy();
  });

  test("surfaces a load error and retries", async () => {
    fetchIncidentsMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    fetchIncidentsMock.mockResolvedValue([]);
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("No incidents")).toBeTruthy();
  });

  test("renders a friendly message for a 403", async () => {
    fetchIncidentsMock.mockRejectedValue(
      new ApiError("Forbidden", 403)
    );

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(
      await screen.findByText("You do not have access to this project.")
    ).toBeTruthy();
  });

  test("acknowledging an open incident updates it in place", async () => {
    fetchIncidentsMock.mockResolvedValue([openIncident]);
    acknowledgeMock.mockResolvedValue({
      ...openIncident,
      status: "acknowledged",
      acknowledged_at: "2026-10-25T15:10:00.000Z",
    });

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByLabelText(/Acknowledge incident/));
    expect(acknowledgeMock).toHaveBeenCalledWith(
      projects[0].id,
      openIncident.id
    );
    expect(await screen.findByText("acknowledged")).toBeTruthy();
  });

  test("resolving an incident removes its action buttons", async () => {
    fetchIncidentsMock.mockResolvedValue([openIncident]);
    resolveMock.mockResolvedValue({
      ...openIncident,
      status: "resolved",
      resolved_at: "2026-10-25T15:11:00.000Z",
      resolution: "manual",
    });

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByLabelText(/Resolve incident/));
    expect(resolveMock).toHaveBeenCalledWith(projects[0].id, openIncident.id);
    expect(await screen.findByText(/resolved · manual/)).toBeTruthy();
    expect(screen.queryByLabelText(/Resolve incident/)).toBeNull();
  });

  test("a 409 conflict refreshes the list instead of erroring", async () => {
    fetchIncidentsMock.mockResolvedValueOnce([openIncident]);
    resolveMock.mockRejectedValueOnce(
      new ApiError("Incident is already resolved", 409)
    );
    fetchIncidentsMock.mockResolvedValueOnce([
      { ...openIncident, status: "resolved", resolution: "auto" },
    ]);

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByLabelText(/Resolve incident/));
    expect(await screen.findByText(/resolved · auto/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("switching the status filter refetches with the new filter", async () => {
    fetchIncidentsMock.mockResolvedValue([openIncident]);

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );
    await screen.findByText("Deployment failed on main");

    fetchIncidentsMock.mockResolvedValue([acknowledgedIncident]);
    fireEvent.click(screen.getByRole("tab", { name: "Acknowledged" }));

    expect(await screen.findByText(/TLS certificate expired/)).toBeTruthy();
    expect(fetchIncidentsMock).toHaveBeenLastCalledWith(
      projects[0].id,
      { status: "acknowledged", limit: 100 },
      expect.anything()
    );
  });

  test("critical incidents render the critical pill", async () => {
    fetchIncidentsMock.mockResolvedValue([acknowledgedIncident]);

    render(
      <IncidentsView
        projects={projects}
        selectedProjectId={projects[0].id}
        onSelectProject={vi.fn()}
      />
    );

    expect(await screen.findByText("critical")).toBeTruthy();
  });
});
