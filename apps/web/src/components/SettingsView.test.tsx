// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsView } from "./SettingsView";
import {
  createProjectEnvVar,
  deleteProjectEnvVar,
  fetchBuildConfig,
  fetchProjectEnvVars,
  updateProject,
  updateProjectEnvVar,
} from "../lib/api";
import type { Project, ProjectEnvVar } from "../types";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    fetchProjectEnvVars: vi.fn(),
    createProjectEnvVar: vi.fn(),
    updateProjectEnvVar: vi.fn(),
    deleteProjectEnvVar: vi.fn(),
    fetchBuildConfig: vi.fn(),
  };
});

const updateProjectMock = vi.mocked(updateProject);
const fetchEnvMock = vi.mocked(fetchProjectEnvVars);
const createEnvMock = vi.mocked(createProjectEnvVar);
const updateEnvMock = vi.mocked(updateProjectEnvVar);
const deleteEnvMock = vi.mocked(deleteProjectEnvVar);
const fetchBuildConfigMock = vi.mocked(fetchBuildConfig);

const testProject: Project = {
  id: "12345678-1234-4234-8234-123456789abc",
  name: "acme-service",
  repository_url: "https://github.com/acme/service.git",
  branch: "main",
  created_at: "2026-10-20T00:00:00.000Z",
};

const mockEnvVars: ProjectEnvVar[] = [
  {
    id: "var-1",
    project_id: testProject.id,
    key: "DATABASE_URL",
    value: "••••••••",
    is_secret: true,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
  },
  {
    id: "var-2",
    project_id: testProject.id,
    key: "NODE_ENV",
    value: "production",
    is_secret: false,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
  },
];

describe("SettingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchBuildConfigMock.mockResolvedValue({
      config: null,
      updatedAt: null,
    });
    fetchEnvMock.mockResolvedValue(mockEnvVars);
  });

  afterEach(() => {
    cleanup();
  });

  test("renders empty state when project is undefined", () => {
    render(<SettingsView project={undefined} />);
    expect(screen.getByText("No workspace selected")).toBeTruthy();
  });

  test("renders workspace identity and allows editing name and branch", async () => {
    const onNotify = vi.fn();
    const onProjectUpdate = vi.fn();
    updateProjectMock.mockResolvedValue({
      ...testProject,
      name: "renamed-service",
      branch: "develop",
    });

    render(
      <SettingsView
        project={testProject}
        onNotify={onNotify}
        onProjectUpdate={onProjectUpdate}
      />
    );

    const nameInput = screen.getByDisplayValue("acme-service") as HTMLInputElement;
    const branchInput = screen.getByDisplayValue("main") as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

    // Initially save button is disabled because values match project
    expect(saveButton.disabled).toBe(true);

    // Modify name
    fireEvent.change(nameInput, { target: { value: "renamed-service" } });
    expect(saveButton.disabled).toBe(false);

    // Modify branch
    fireEvent.change(branchInput, { target: { value: "develop" } });

    // Click save
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateProjectMock).toHaveBeenCalledWith(testProject.id, {
        name: "renamed-service",
        branch: "develop",
      });
      expect(onNotify).toHaveBeenCalledWith("Workspace settings updated");
      expect(onProjectUpdate).toHaveBeenCalled();
    });
  });

  test("renders environment variables and displays masked secrets vs plaintext", async () => {
    render(<SettingsView project={testProject} />);

    await waitFor(() => {
      expect(fetchEnvMock).toHaveBeenCalledWith(testProject.id);
    });

    // Check table headers and rows
    expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    expect(screen.getByText("••••••••")).toBeTruthy();
    expect(screen.getByText("Secret")).toBeTruthy();

    expect(screen.getByText("NODE_ENV")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy();
    expect(screen.getByText("Plaintext")).toBeTruthy();
  });

  test("allows adding a new environment variable", async () => {
    const onNotify = vi.fn();
    createEnvMock.mockResolvedValue({
      id: "var-3",
      project_id: testProject.id,
      key: "STRIPE_SECRET",
      value: "••••••••",
      is_secret: true,
      created_at: "2026-10-21T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
    });

    render(<SettingsView project={testProject} onNotify={onNotify} />);

    await waitFor(() => {
      expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    });

    // Open add variable form
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));

    const keyInput = screen.getByPlaceholderText("API_KEY");
    const valInput = screen.getByPlaceholderText("value");
    const submitBtn = screen.getByRole("button", { name: "Add" });

    fireEvent.change(keyInput, { target: { value: "stripe_secret" } }); // will auto-uppercase to STRIPE_SECRET
    fireEvent.change(valInput, { target: { value: "sk_test_123" } });

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createEnvMock).toHaveBeenCalledWith(testProject.id, {
        key: "STRIPE_SECRET",
        value: "sk_test_123",
        isSecret: true,
      });
      expect(onNotify).toHaveBeenCalledWith("Added STRIPE_SECRET");
      expect(screen.getByText("STRIPE_SECRET")).toBeTruthy();
    });
  });

  test("allows editing an existing environment variable", async () => {
    const onNotify = vi.fn();
    updateEnvMock.mockResolvedValue({
      ...mockEnvVars[1],
      value: "staging",
    });

    render(<SettingsView project={testProject} onNotify={onNotify} />);

    await waitFor(() => {
      expect(screen.getByText("NODE_ENV")).toBeTruthy();
    });

    // Click edit on NODE_ENV
    const editBtn = screen.getByRole("button", { name: "Edit NODE_ENV" });
    fireEvent.click(editBtn);

    // Edit value
    const valInput = screen.getByDisplayValue("production");
    fireEvent.change(valInput, { target: { value: "staging" } });

    // Click save in the row
    const rowSaveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(rowSaveBtn);

    await waitFor(() => {
      expect(updateEnvMock).toHaveBeenCalledWith(testProject.id, "var-2", {
        key: "NODE_ENV",
        value: "staging",
        isSecret: false,
      });
      expect(onNotify).toHaveBeenCalledWith("Updated NODE_ENV");
    });
  });

  test("allows deleting an environment variable", async () => {
    const onNotify = vi.fn();
    deleteEnvMock.mockResolvedValue();

    render(<SettingsView project={testProject} onNotify={onNotify} />);

    await waitFor(() => {
      expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    });

    const deleteBtn = screen.getByRole("button", { name: "Delete DATABASE_URL" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteEnvMock).toHaveBeenCalledWith(testProject.id, "var-1");
      expect(onNotify).toHaveBeenCalledWith("Deleted DATABASE_URL");
      expect(screen.queryByText("DATABASE_URL")).toBeNull();
    });
  });

  test("danger zone requires typing workspace name to confirm deletion", async () => {
    const onNotify = vi.fn();
    const onProjectDelete = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        project={testProject}
        onNotify={onNotify}
        onProjectDelete={onProjectDelete}
      />
    );

    // Click delete workspace button in panel
    const openModalBtn = screen.getByRole("button", { name: "Delete workspace" });
    fireEvent.click(openModalBtn);

    // Modal opens
    expect(screen.getByText(/This action/i)).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Permanently delete workspace" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Type incorrect name
    const confirmInput = screen.getByPlaceholderText("acme-service");
    fireEvent.change(confirmInput, { target: { value: "wrong-name" } });
    expect(confirmBtn.disabled).toBe(true);

    // Type exact name
    fireEvent.change(confirmInput, { target: { value: "acme-service" } });
    expect(confirmBtn.disabled).toBe(false);

    // Click confirm
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onProjectDelete).toHaveBeenCalledWith(testProject.id);
      expect(onNotify).toHaveBeenCalledWith("Workspace deleted");
      expect(screen.queryByText(/Permanently delete workspace/i)).toBeNull();
    });
  });
});
