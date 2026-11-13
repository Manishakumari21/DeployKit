// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorDoctor } from "./ErrorDoctor";
import { diagnoseDeploymentError } from "../lib/errorDoctor";

describe("diagnoseDeploymentError", () => {
  test("identifies health check / 0.0.0.0 vs localhost pitfall", () => {
    const diag = diagnoseDeploymentError("HEALTH_CHECK_FAILED", "Connection refused at 127.0.0.1:3000");
    expect(diag.category).toBe("Container Connectivity");
    expect(diag.headline).toContain("Health Probes");
    expect(diag.beginnerTrap).toContain("0.0.0.0");
    expect(diag.snippets).toBeDefined();
    expect(diag.snippets!.length).toBeGreaterThan(0);
    expect(diag.suggestedAction?.targetTab).toBe("settings");
  });

  test("identifies build failures and missing modules", () => {
    const diag = diagnoseDeploymentError("BUILD_FAILED", "Error: Cannot find module 'express'");
    expect(diag.category).toBe("Application Build");
    expect(diag.headline).toBe("Missing Package Dependency");
    expect(diag.beginnerTrap).toContain("package.json");
    expect(diag.suggestedAction?.targetTab).toBe("logs");
  });

  test("identifies OOM (Exit code 137) crashes", () => {
    const diag = diagnoseDeploymentError("RUNTIME_CONTAINER_NOT_RUNNING", "Process killed with exit code 137");
    expect(diag.category).toBe("Runtime Lifecycle");
    expect(diag.headline).toContain("Out of Memory");
    expect(diag.recommendedSteps[0]).toContain("memory");
  });

  test("identifies git clone failures", () => {
    const diag = diagnoseDeploymentError("CLONE_FAILED", "fatal: repository not found");
    expect(diag.category).toBe("Git Repository Access");
    expect(diag.headline).toContain("Clone");
  });

  test("provides friendly generic diagnosis for unmapped errors", () => {
    const diag = diagnoseDeploymentError("UNKNOWN_ERROR", "Something broke");
    expect(diag.category).toBe("Deployment Diagnostics");
    expect(diag.headline).toBe("Flight Interrupted");
  });
});

describe("ErrorDoctor Component", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders diagnosis headline, beginner trap, and recommended steps", () => {
    const onNavigate = vi.fn();
    const onRetry = vi.fn();

    render(
      <ErrorDoctor
        errorCode="HEALTH_CHECK_FAILED"
        errorMessage="connect ECONNREFUSED 127.0.0.1:3000"
        onNavigate={onNavigate}
        onRetry={onRetry}
      />
    );

    expect(screen.getByText(/Smart Doctor Diagnosis/i)).toBeTruthy();
    expect(screen.getByText(/Server Did Not Respond to Health Probes/i)).toBeTruthy();
    expect(screen.getByText(/The #1 beginner pitfall in Docker/i)).toBeTruthy();
    expect(screen.getByText(/Ensure your server listens on host 0.0.0.0/i)).toBeTruthy();

    // Code snippet is rendered
    expect(screen.getByText("Node.js / Express")).toBeTruthy();
    expect(screen.getByText("Python / FastAPI")).toBeTruthy();

    // Toggle raw error view
    const toggleBtn = screen.getByText(/View raw error codes/i);
    fireEvent.click(toggleBtn);
    expect(screen.getByText(/Error Code: HEALTH_CHECK_FAILED/i)).toBeTruthy();

    // Action buttons
    const actionBtn = screen.getByRole("button", { name: /Check Environment & Port Settings/i });
    fireEvent.click(actionBtn);
    expect(onNavigate).toHaveBeenCalledWith("settings");

    const retryBtn = screen.getByRole("button", { name: /Retry Flight/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
