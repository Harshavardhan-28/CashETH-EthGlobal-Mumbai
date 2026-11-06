import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { HowItWorks } from "./HowItWorks";

let scrollY = 0;
const scene = (n: number) => document.querySelector(`[data-scene="${n}"]`) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  scrollY = 0;
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "scrollY", { get: () => scrollY, configurable: true });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  // Copy blocks are 700px apart; block i is centred on the viewport when scrollY = i * 700.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const i = this.getAttribute("data-hw");
    const top = i === null ? 0 : Number(i) * 700 - scrollY + 350;
    return { top, height: 100, bottom: top + 100, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockReducedMotion(false);
});

const scrollTo = (y: number) => {
  scrollY = y;
  act(() => {
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(32);
  });
};

describe("HowItWorks", () => {
  it("explains the four moves", () => {
    render(<HowItWorks />);
    for (const t of ["Invoice in", "Capital out", "Agents spend", "Lenders repaid"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
  });

  it("starts on the first scene", () => {
    render(<HowItWorks />);
    expect(scene(1)).toHaveAttribute("data-active", "true");
    expect(scene(2)).toHaveAttribute("data-active", "false");
  });

  it("follows the scroll position", () => {
    render(<HowItWorks />);
    scrollTo(1400);
    expect(scene(3)).toHaveAttribute("data-active", "true");
    expect(scene(1)).toHaveAttribute("data-active", "false");
    scrollTo(0);
    expect(scene(1)).toHaveAttribute("data-active", "true");
  });

  it("marks progress up to the active scene", () => {
    render(<HowItWorks />);
    scrollTo(700);
    expect(screen.getByRole("button", { name: /02 Capital out/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: /03 Agents spend/ })).not.toHaveAttribute("aria-current");
  });

  it("scrolls smoothly to a block from the progress labels", () => {
    render(<HowItWorks />);
    fireEvent.click(screen.getByRole("button", { name: /04 Repaid/ }));
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("fills the funding bar when the capital scene is active", () => {
    render(<HowItWorks />);
    expect(screen.getByTestId("fund-bar").style.width).toBe("0%");
    scrollTo(700);
    expect(screen.getByTestId("fund-bar").style.width).toBe("60%");
  });

  it("shows the capital routes as tool names", () => {
    render(<HowItWorks />);
    expect(screen.getByText("upload_receivable")).toBeInTheDocument();
    expect(screen.getByText("repay_receivable")).toBeInTheDocument();
  });

  it("does not track scroll after unmount", () => {
    const { unmount } = render(<HowItWorks />);
    unmount();
    expect(() => scrollTo(700)).not.toThrow();
  });
});
