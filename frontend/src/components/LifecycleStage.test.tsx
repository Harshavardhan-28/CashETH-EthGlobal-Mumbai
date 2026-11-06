import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { LifecycleStage } from "./LifecycleStage";

const title = () => screen.getByTestId("step-title").textContent;
const actor = () => screen.getByTestId("step-actor").textContent;
const node = (container: HTMLElement, key: string) => container.querySelector(`[data-node="${key}"]`)!;
const run = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const playButton = () => screen.getByRole("button", { name: "Play or pause" });

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
    expect(screen.getByTestId("step-number")).toHaveTextContent("01");
    expect(title()).toBe("Upload");
    expect(actor()).toBe("Seller");
    expect(playButton()).toHaveTextContent("❚❚");
  });

  it("advances automatically and keeps looping", () => {
    render(<LifecycleStage />);
    run(4400);
    expect(title()).toBe("Confirm");
    run(4400 * 7);
    expect(title()).toBe("Upload");
  });

  it("pauses on request and resumes", () => {
    render(<LifecycleStage />);
    fireEvent.click(playButton());
    expect(playButton()).toHaveTextContent("▶");
    run(20000);
    expect(title()).toBe("Upload");
    fireEvent.click(playButton());
    run(4400);
    expect(title()).toBe("Confirm");
  });

  it("next and previous wrap around and pause autoplay", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(title()).toBe("Repay");
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(title()).toBe("Upload");
    run(20000);
    expect(title()).toBe("Upload");
    expect(playButton()).toHaveTextContent("▶");
  });

  it("jumps to a step from the progress bar and marks it current", () => {
    render(<LifecycleStage />);
    fireEvent.click(screen.getByRole("button", { name: "Step 5" }));
    expect(title()).toBe("Ship");
    expect(actor()).toBe("Lenders");
    expect(screen.getByRole("button", { name: "Step 5" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Step 4" })).not.toHaveAttribute("aria-current");
  });

  it("shows the packet label for the current step", () => {
    render(<LifecycleStage />);
    expect(screen.getByText("INVOICE")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Step 2" }));
    expect(screen.getByText("EIP-712 SIG")).toBeInTheDocument();
  });

  describe("hovering the board", () => {
    it("jumps to the step a node belongs to", () => {
      const { container } = render(<LifecycleStage />);
      fireEvent.mouseEnter(node(container, "registry"));
      expect(title()).toBe("Register");
      expect(actor()).toBe("Hedera");
    });

    it("holds the step while the pointer is on a node", () => {
      const { container } = render(<LifecycleStage />);
      fireEvent.mouseEnter(node(container, "registry"));
      run(20000);
      expect(title()).toBe("Register");
    });

    it("resumes autoplay shortly after the pointer leaves", () => {
      const { container } = render(<LifecycleStage />);
      fireEvent.mouseEnter(node(container, "registry"));
      fireEvent.mouseLeave(node(container, "registry"));
      run(300);
      run(4400);
      expect(title()).toBe("Ship");
    });

    it("does not resume when the pointer slides straight onto another node", () => {
      const { container } = render(<LifecycleStage />);
      fireEvent.mouseEnter(node(container, "registry"));
      fireEvent.mouseLeave(node(container, "registry"));
      run(100);
      fireEvent.mouseEnter(node(container, "workers"));
      run(5000);
      expect(title()).toBe("Spend");
    });

    it("also responds to the agents, not just the blocks", () => {
      const { container } = render(<LifecycleStage />);
      const figure = container.querySelector('[data-node="lenders"][data-figure]')!;
      fireEvent.mouseEnter(figure);
      expect(title()).toBe("Ship");
    });

    it("stays paused if the user paused it", () => {
      const { container } = render(<LifecycleStage />);
      fireEvent.click(playButton());
      fireEvent.mouseEnter(node(container, "router"));
      expect(title()).toBe("Repay");
      fireEvent.mouseLeave(node(container, "router"));
      run(20000);
      expect(title()).toBe("Repay");
    });
  });

  it("is a fixed view: dragging does not rotate the board", () => {
    render(<LifecycleStage />);
    const plane = screen.getByTestId("plane");
    const before = plane.style.transform;
    expect(before).toContain("rotateZ(-40deg)");
    fireEvent.pointerDown(screen.getByTestId("stage"), { clientX: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(plane.style.transform).toBe(before);
  });

  it("under reduced motion parks on a finished step without autoplay", () => {
    mockReducedMotion(true);
    render(<LifecycleStage />);
    expect(title()).toBe("Fund");
    expect(playButton()).toHaveTextContent("▶");
    run(20000);
    expect(title()).toBe("Fund");
  });
});
