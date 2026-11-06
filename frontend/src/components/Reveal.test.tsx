import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { Reveal } from "./Reveal";

let observer: { cb: IntersectionObserverCallback; unobserved: Element[] } | null;

beforeEach(() => {
  observer = null;
  class FakeIO {
    constructor(cb: IntersectionObserverCallback) {
      observer = { cb, unobserved: [] };
    }
    observe() {}
    unobserve(el: Element) {
      observer!.unobserved.push(el);
    }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockReducedMotion(false);
});

const enter = (el: Element) =>
  act(() => observer!.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], {} as IntersectionObserver));

describe("Reveal", () => {
  it("hides its content until it scrolls into view", () => {
    render(<Reveal data-testid="r">hello</Reveal>);
    const el = screen.getByTestId("r");
    expect(el.style.opacity).toBe("0");
    expect(el.style.transform).toBe("translateY(36px)");
    enter(el);
    expect(el.style.opacity).toBe("1");
    expect(el.style.transform).toBe("none");
  });

  it("only reveals once", () => {
    render(<Reveal data-testid="r">hello</Reveal>);
    const el = screen.getByTestId("r");
    enter(el);
    expect(observer!.unobserved).toContain(el);
  });

  it("staggers siblings by index, capped", () => {
    render(
      <>
        <Reveal data-testid="a" index={2}>a</Reveal>
        <Reveal data-testid="b" index={20}>b</Reveal>
      </>,
    );
    expect(screen.getByTestId("a").style.transition).toContain("160ms");
    expect(screen.getByTestId("b").style.transition).toContain("480ms");
  });

  it("does not hide anything under reduced motion", () => {
    mockReducedMotion(true);
    render(<Reveal data-testid="r">hello</Reveal>);
    expect(screen.getByTestId("r").style.opacity).toBe("");
  });

  it("stays visible when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Reveal data-testid="r">hello</Reveal>);
    expect(screen.getByTestId("r").style.opacity).toBe("");
  });
});
