import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockReducedMotion } from "../../vitest.setup";
import { CreditCeiling } from "./CreditCeiling";
import { Footer } from "./Footer";
import { HeroFx } from "./HeroFx";
import { Principles } from "./Principles";
import { Waterfall } from "./Waterfall";

type Entry = { cb: IntersectionObserverCallback; els: Element[] };
let observers: Entry[];

const seeAll = () =>
  act(() => {
    observers.forEach((o) =>
      o.cb(o.els.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver),
    );
  });

beforeEach(() => {
  observers = [];
  class FakeIO {
    entry: Entry;
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, els: [] };
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.els.push(el);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockReducedMotion(false);
});

describe("CreditCeiling", () => {
  it("states the point", () => {
    render(<CreditCeiling />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("More agents never means more credit.");
  });

  it("draws the bars only once the card scrolls into view", () => {
    render(<CreditCeiling />);
    const bar = (name: string) => screen.getByText(name) as HTMLElement;
    expect(bar("A · 7.00%").style.width).toBe("0%");
    expect(bar("Compute").style.width).toBe("0%");
    seeAll();
    expect(bar("A · 7.00%").style.width).toBe("40%");
    expect(bar("B · 8.50%").style.width).toBe("20%");
    expect(bar("Compute").style.width).toBe("30%");
  });

  it("keeps the agent budgets inside what was funded", () => {
    render(<CreditCeiling />);
    seeAll();
    const w = (name: string) => parseFloat((screen.getByText(name) as HTMLElement).style.width);
    const budgets = w("Research") + w("Compute") + w("Data") + w("Reserve");
    const funded = w("A · 7.00%") + w("B · 8.50%");
    expect(budgets).toBeLessThanOrEqual(funded);
  });

  it("explains the 75% advance", () => {
    render(<CreditCeiling />);
    expect(screen.getByText(/75% advance · borrowing base \$7,500/)).toBeInTheDocument();
  });
});

describe("Waterfall", () => {
  it("shows lenders ahead of the seller", () => {
    render(<Waterfall />);
    const rows = screen.getAllByTestId("payout").map((r) => r.textContent);
    expect(rows).toEqual(["Lender A4,023.01", "Lender B2,013.97", "Seller agent3,963.01"]);
  });

  it("pays out in full: lenders plus seller equal what the buyer paid", () => {
    render(<Waterfall />);
    const amounts = screen.getAllByTestId("payout-amount").map((e) => parseFloat((e.textContent ?? "").replace(/,/g, "")));
    // Each lender's fee is rounded to the cent on its own, so the shares can drift by a cent.
    expect(Math.abs(amounts.reduce((a, b) => a + b, 0) - 10000)).toBeLessThanOrEqual(0.01 + 1e-9);
  });

  it("fills the split bar only once in view", () => {
    render(<Waterfall />);
    expect(screen.getByTestId("split-a").style.width).toBe("0%");
    seeAll();
    expect(screen.getByTestId("split-a").style.width).toBe("40.23%");
    expect(screen.getByTestId("split-b").style.width).toBe("20.14%");
    expect(screen.getByTestId("split-s").style.width).toBe("39.63%");
  });

  it("shows the fee formula", () => {
    render(<Waterfall />);
    expect(screen.getByText("fee = principal × apr × max(elapsed, 30d) / 365d")).toBeInTheDocument();
  });
});

describe("Principles", () => {
  it("lists the three principles", () => {
    render(<Principles />);
    expect(screen.getByText("The buyer's signature is the root of trust.")).toBeInTheDocument();
    expect(screen.getByText("Every limit is checked twice.")).toBeInTheDocument();
    expect(screen.getByText("AI explains. It never approves.")).toBeInTheDocument();
  });

  it("credits the stack", () => {
    render(<Principles />);
    for (const name of ["Hedera", "1inch Aqua", "USDC", "x402", "MCP"]) expect(screen.getByText(name)).toBeInTheDocument();
  });
});

describe("Footer", () => {
  it("closes with a call to action to the docs and the demo", () => {
    render(<Footer />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Cash me if you can.");
    expect(screen.getByRole("link", { name: /Read the docs/ })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: /npm run demo/ })).toHaveAttribute("href", "/docs#quickstart");
  });

  it("invites visitors to try it and send feedback through the issue form", () => {
    render(<Footer />);
    const link = screen.getByRole("link", { name: /Give feedback/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/Harshavardhan-28/CashETH-EthGlobal-Mumbai/issues/new?template=feedback.yml",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("is honest that this is a testnet demo", () => {
    render(<Footer />);
    expect(screen.getByText("Hedera testnet demo · not production credit")).toBeInTheDocument();
  });
});

describe("HeroFx", () => {
  const setScroll = (y: number) => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    setScroll(0);
  });

  it("fades the hero out as the page scrolls", () => {
    render(<HeroFx data-testid="hero">x</HeroFx>);
    act(() => void vi.advanceTimersByTime(32));
    expect(screen.getByTestId("hero").style.opacity).toBe("");
    setScroll(720);
    act(() => void vi.advanceTimersByTime(32));
    expect(Number(screen.getByTestId("hero").style.opacity)).toBeCloseTo(0.1, 3);
    expect(screen.getByTestId("hero").style.transform).toContain("translateY(80px)");
  });

  it("restores the hero when scrolled back to the top", () => {
    render(<HeroFx data-testid="hero">x</HeroFx>);
    setScroll(720);
    act(() => void vi.advanceTimersByTime(32));
    setScroll(0);
    act(() => void vi.advanceTimersByTime(32));
    expect(Number(screen.getByTestId("hero").style.opacity)).toBe(1);
    expect(screen.getByTestId("hero").style.transform).toBe("");
  });

  it("does nothing under reduced motion", () => {
    mockReducedMotion(true);
    render(<HeroFx data-testid="hero">x</HeroFx>);
    setScroll(720);
    act(() => void vi.advanceTimersByTime(32));
    expect(screen.getByTestId("hero").style.opacity).toBe("");
  });
});
