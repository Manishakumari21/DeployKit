// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ReleasesPanel } from "./ReleasesPanel";
import { fetchReleases, rollbackDeployment } from "../lib/api";
import type { Release } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchReleases: vi.fn(),
    rollbackDeployment: vi.fn(),
  };
});

const fetchReleasesMock = vi.mocked(fetchReleases);
const rollbackMock = vi.mocked(rollbackDeployment);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const healthyRelease: Release = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deployment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  project_id: PROJECT_ID,
  image_repository: "deploykit/web",
  image_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  status: "healthy",
  supersedes_release_id: null,
  error_code: null,
  error_message: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  started_at: null,
  healthy_at: null,
  activated_at: null,
  stopped_at: null,
};

const failedRelease: Release = {
  ...healthyRelease,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  status: "failed",
  image_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ReleasesPanel", () => {
  test("lists releases and rolls back after confirmation", async () => {
    fetchReleasesMock.mockResolvedValue([healthyRelease, failedRelease]);
    rollbackMock.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      project_id: PROJECT_ID,
      status: "queued",
      trigger: "rollback",
      branch: "main",
      commit_sha: null,
      image_repository: null,
      image_digest: null,
      error_code: null,
      error_message: null,
      idempotency_key: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      updated_at: new Date().toISOString(),
    });
    const onRollbackStarted = vi.fn();

    render(
      <ReleasesPanel
        projectId={PROJECT_ID}
        activeDeploymentBusy={false}
        onRollbackStarted={onRollbackStarted}
      />
    );

    expect(await screen.findByText(/sha256:111111111111/)).toBeTruthy();
    expect(screen.getByText(/sha256:222222222222/)).toBeTruthy();

    const rollbacks = screen.getAllByRole("button", { name: "Roll back" });
    expect(rollbacks).toHaveLength(2);
    const disabled = rollbacks.filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].getAttribute("title")).toBe("Cannot roll back to a failed release");

    fireEvent.click(rollbacks.find((b) => !(b as HTMLButtonElement).disabled)!);
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    expect(rollbackMock).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(rollbackMock).toHaveBeenCalledTimes(1));
    expect(rollbackMock).toHaveBeenCalledWith(
      PROJECT_ID,
      healthyRelease.id,
      expect.any(String)
    );
    expect(onRollbackStarted).toHaveBeenCalledTimes(1);
  });

  test("failed releases are rendered but not offered as rollback targets", async () => {
    fetchReleasesMock.mockResolvedValue([failedRelease]);

    render(
      <ReleasesPanel
        projectId={PROJECT_ID}
        activeDeploymentBusy={false}
        onRollbackStarted={vi.fn()}
      />
    );

    await screen.findByText(/sha256:222222222222/);
    const rollback = screen.getByRole("button", { name: "Roll back" });
    expect((rollback as HTMLButtonElement).disabled).toBe(true);
    expect(rollback.getAttribute("title")).toBe("Cannot roll back to a failed release");
  });

  test("rollback controls are disabled while a deployment is in flight", async () => {
    fetchReleasesMock.mockResolvedValue([healthyRelease]);

    render(
      <ReleasesPanel
        projectId={PROJECT_ID}
        activeDeploymentBusy={true}
        onRollbackStarted={vi.fn()}
      />
    );

    await screen.findByText(/sha256:111111111111/);
    const rollback = screen.getByRole("button", { name: "Roll back" });
    expect((rollback as HTMLButtonElement).disabled).toBe(true);
  });

  test("surfaces a rollback error from the API", async () => {
    fetchReleasesMock.mockResolvedValue([healthyRelease]);
    rollbackMock.mockRejectedValue(new Error("Project already has an active deployment"));

    render(
      <ReleasesPanel
        projectId={PROJECT_ID}
        activeDeploymentBusy={false}
        onRollbackStarted={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));

    expect(await screen.findByText("Project already has an active deployment")).toBeTruthy();
  });

  test("shows an empty state when there are no releases", async () => {
    fetchReleasesMock.mockResolvedValue([]);

    render(
      <ReleasesPanel
        projectId={PROJECT_ID}
        activeDeploymentBusy={false}
        onRollbackStarted={vi.fn()}
      />
    );

    expect(await screen.findByText("No releases yet")).toBeTruthy();
  });
});
