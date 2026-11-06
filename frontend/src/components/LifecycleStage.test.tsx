import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { LifecycleStage } from "./LifecycleStage";

const status = () => screen.getByTestId("step-status").textContent;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  mockReducedMotion(false);
});

describe("LifecycleStage", () => {
  it("starts on step 1, playing", () => {
    render(<LifecycleStage />);
    expect(status()).toBe("Step 1 of 8 · Seller");
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("advances automatically and keeps looping", () => {
    render(<LifecycleStage />);
    act(() => void vi.advanceTimersByTime(4400));
    expect(status()).toBe("Step 2 of 8 · Buyer");
    act(() => void vi.advanceTimersByTime(4400 * 7));
    expect(status()).toBe("Step 1 of 8 · Seller");
  });

  it("pauses on request and resumes", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => void vi.advanceTimersByTime(20000));
    expect(status()).toBe("Step 1 of 8 · Seller");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => void vi.advanceTimersByTime(4400));
    expect(status()).toBe("Step 2 of 8 · Buyer");
  });

  it("next and previous wrap around and pause autoplay", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(status()).toBe("Step 8 of 8 · Buyer");
    expect(screen.getByText("Repay")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(status()).toBe("Step 1 of 8 · Seller");
    act(() => void vi.advanceTimersByTime(20000));
    expect(status()).toBe("Step 1 of 8 · Seller");
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("jumps to a step from the progress bar", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Step 5" }));
    expect(status()).toBe("Step 5 of 8 · Lenders");
    expect(screen.getByText("Ship")).toBeInTheDocument();
  });

  it("jumps to the matching step when a node on the board is clicked", () => {
    const { container } = render(<LifecycleStage />);
    fireEvent.click(container.querySelector('[data-node="registry"]')!);
    expect(status()).toBe("Step 4 of 8 · Hedera");
  });

  it("marks the current step in the progress bar", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Step 3" }));
    expect(screen.getByRole("button", { name: "Step 3" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Step 2" })).not.toHaveAttribute("aria-current");
  });

  it("shows the packet label for the current step", () => {
    render(<LifecycleStage />);
    expect(screen.getByText("INVOICE")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Step 2" }));
    expect(screen.getByText("EIP-712 SIG")).toBeInTheDocument();
  });

  it("rotates the board when dragged and ignores the click that ends a drag", () => {
    const { container } = render(<LifecycleStage />);
    const stage = screen.getByTestId("stage");
    const plane = screen.getByTestId("plane");
    const before = plane.style.transform;
    fireEvent.pointerDown(stage, { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(plane.style.transform).not.toBe(before);
    fireEvent.pointerUp(window);
    fireEvent.click(container.querySelector('[data-node="registry"]')!);
    expect(status()).toBe("Step 1 of 8 · Seller");
  });

  it("under reduced motion parks on a finished step without autoplay", () => {
    mockReducedMotion(true);
    render(<LifecycleStage />);
    expect(status()).toBe("Step 6 of 8 · Seller");
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(20000));
    expect(status()).toBe("Step 6 of 8 · Seller");
  });
});
