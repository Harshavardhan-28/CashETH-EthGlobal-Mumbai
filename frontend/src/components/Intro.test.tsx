import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { Intro } from "./Intro";

const overlay = () => screen.queryByTestId("intro");
const run = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  mockReducedMotion(false);
  document.documentElement.style.overflow = "";
});

describe("Intro", () => {
  it("covers the page and locks scrolling while it plays", () => {
    render(<Intro />);
    expect(overlay()).toBeInTheDocument();
    expect(overlay()!.style.opacity).toBe("1");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("narrates the invoice becoming liquidity", () => {
    render(<Intro />);
    expect(screen.getByTestId("intro-caption")).toHaveTextContent("A buyer-signed invoice");
    run(2100);
    expect(screen.getByTestId("intro-caption")).toHaveTextContent("becomes liquidity");
    run(1800);
    expect(screen.getByTestId("intro-caption")).toHaveTextContent("your agents can spend");
  });

  it("counts up to the borrowing base", () => {
    render(<Intro />);
    run(4200);
    expect(screen.getByTestId("intro-amount")).toHaveTextContent("$7,500.00");
  });

  it("dissolves, releases scrolling, then unmounts", () => {
    render(<Intro />);
    run(4900);
    expect(overlay()!.style.opacity).toBe("0");
    expect(overlay()!.style.pointerEvents).toBe("none");
    expect(document.documentElement.style.overflow).toBe("");
    run(900);
    expect(overlay()).toBeNull();
  });

  it("can be skipped", () => {
    render(<Intro />);
    run(300);
    fireEvent.click(screen.getByRole("button", { name: /skip intro/i }));
    expect(overlay()!.style.opacity).toBe("0");
    expect(screen.getByTestId("intro-amount")).toHaveTextContent("$7,500.00");
    expect(document.documentElement.style.overflow).toBe("");
    run(900);
    expect(overlay()).toBeNull();
  });

  it("does not play at all under reduced motion", () => {
    mockReducedMotion(true);
    render(<Intro />);
    expect(overlay()).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("releases scrolling if it unmounts mid-animation", () => {
    const { unmount } = render(<Intro />);
    unmount();
    expect(document.documentElement.style.overflow).toBe("");
  });
});
