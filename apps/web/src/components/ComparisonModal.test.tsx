// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComparisonModal } from "./ComparisonModal";

describe("ComparisonModal", () => {
  afterEach(() => {
    cleanup();
  });

  test("does not render when open is false", () => {
    render(<ComparisonModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByText("Why DeployKit? — Platform Comparison")).toBeNull();
  });

  test("renders comparison table and pillars when open is true", () => {
    const onClose = vi.fn();
    render(<ComparisonModal open={true} onClose={onClose} />);

    expect(screen.getByText("Why DeployKit? — Platform Comparison")).toBeTruthy();
    expect(screen.getByText("$0 PaaS Markup")).toBeTruthy();
    expect(screen.getAllByText("Smart Error Doctor").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Zero-Trust Privacy")).toBeTruthy();
    expect(screen.getByText("Edge Node Swarms")).toBeTruthy();

    expect(screen.getByText("DeployKit (Self-Hosted)")).toBeTruthy();
    expect(screen.getByText("Vercel")).toBeTruthy();
    expect(screen.getByText("Render")).toBeTruthy();
    expect(screen.getByText("Railway")).toBeTruthy();

    const closeBtn = screen.getByRole("button", { name: "Close comparison" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("triggers onClose when clicking continue to dashboard", () => {
    const onClose = vi.fn();
    render(<ComparisonModal open={true} onClose={onClose} />);

    const continueBtn = screen.getByRole("button", { name: /Continue to Dashboard/i });
    fireEvent.click(continueBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
