// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LandingPage } from "./LandingPage";

describe("LandingPage", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders positioning, differentiators, and comparison table", () => {
    const onGetStarted = vi.fn();
    const onSignIn = vi.fn();

    render(<LandingPage onGetStarted={onGetStarted} onSignIn={onSignIn} />);

    expect(screen.getByText(/Your infrastructure\./i)).toBeTruthy();
    expect(screen.getByText(/DeployKit vs\. Managed Hosting Platforms/i)).toBeTruthy();
    expect(screen.getByText("Self-Hosted Infrastructure")).toBeTruthy();
    expect(screen.getByText("No Platform Vendor Lock-In")).toBeTruthy();

    const getStartedBtn = screen.getByRole("button", { name: /Commission Control Plane/i });
    fireEvent.click(getStartedBtn);
    expect(onGetStarted).toHaveBeenCalledTimes(1);

    const signInBtn = screen.getByRole("button", { name: "Sign In" });
    fireEvent.click(signInBtn);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
