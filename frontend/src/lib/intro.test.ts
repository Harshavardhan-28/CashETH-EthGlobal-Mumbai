import { describe, expect, it } from "vitest";
import {
  COINS,
  FINAL_PHASE,
  INTRO_AMOUNT,
  INTRO_TIMELINE,
  formatAmount,
  introFrame,
  coinFrame,
} from "./intro";

describe("timeline", () => {
  it("steps through the phases in order, ending on the final phase", () => {
    const times = INTRO_TIMELINE.map(([t]) => t);
    const phases = INTRO_TIMELINE.map(([, p]) => p);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(phases).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(phases[phases.length - 1]).toBe(FINAL_PHASE);
  });
});

describe("formatAmount", () => {
  it("formats whole dollars with thousands separators and cents", () => {
    expect(formatAmount(0)).toBe("$0.00");
    expect(formatAmount(7500)).toBe("$7,500.00");
  });

  it("counts up to the borrowing base", () => {
    expect(INTRO_AMOUNT).toBe(7500);
  });
});

describe("introFrame", () => {
  it("narrates the three beats", () => {
    expect(introFrame(1, 800).caption).toBe("A buyer-signed invoice");
    expect(introFrame(2, 800).caption).toBe("A buyer-signed invoice");
    expect(introFrame(3, 800).caption).toBe("becomes liquidity");
    expect(introFrame(4, 800).caption).toBe("becomes liquidity");
    expect(introFrame(5, 800).caption).toBe("your agents can spend");
  });

  it("shows the invoice only before the coins are minted", () => {
    expect(introFrame(0, 800).invoiceOpacity).toBe(0);
    expect(introFrame(1, 800).invoiceOpacity).toBe(1);
    expect(introFrame(2, 800).invoiceOpacity).toBe(1);
    expect(introFrame(3, 800).invoiceOpacity).toBe(0);
  });

  it("stamps the invoice VERIFIED for exactly one phase", () => {
    expect(introFrame(1, 800).stampOpacity).toBe(0);
    expect(introFrame(2, 800).stampOpacity).toBe(1);
    expect(introFrame(3, 800).stampOpacity).toBe(0);
  });

  it("scales the invoice down on short viewports but never above 1", () => {
    const scale = (vh: number) => Number(/scale\(([\d.]+)\)/.exec(introFrame(1, vh).invoiceTransform)![1]);
    expect(scale(2000)).toBe(1);
    expect(scale(400)).toBe(0.6);
    expect(scale(600)).toBeCloseTo((600 - 220) / 600);
  });

  it("fills the pool and shows the headline amount after the coins land", () => {
    expect(introFrame(3, 800).poolHeight).toBe("0%");
    expect(introFrame(4, 800).poolHeight).toBe("64%");
    expect(introFrame(4, 800).waveOpacity).toBe(1);
    expect(introFrame(4, 800).labelOpacity).toBe(0);
    expect(introFrame(5, 800).labelOpacity).toBe(1);
  });

  it("dissolves the overlay and stops blocking clicks from phase 6", () => {
    expect(introFrame(5, 800).overlayOpacity).toBe(1);
    expect(introFrame(5, 800).overlayPointerEvents).toBe("auto");
    expect(introFrame(6, 800).overlayOpacity).toBe(0);
    expect(introFrame(6, 800).overlayPointerEvents).toBe("none");
  });
});

describe("coins", () => {
  it("has twenty coins cycling USDC, HBAR, USDC, ETH", () => {
    expect(COINS).toHaveLength(20);
    expect(COINS.slice(0, 4).map((c) => c.type)).toEqual(["usdc", "hbar", "usdc", "eth"]);
  });

  it("stays hidden until the invoice is verified", () => {
    expect(coinFrame(COINS[0], 0, 2, 800).opacity).toBe(0);
    expect(coinFrame(COINS[0], 0, 3, 800).opacity).toBe(1);
  });

  it("bursts outward, then drops into the pool and fades once the pool is full", () => {
    const burst = coinFrame(COINS[0], 0, 3, 800);
    const drop = coinFrame(COINS[0], 0, 4, 800);
    expect(burst.transform).not.toBe(drop.transform);
    expect(coinFrame(COINS[0], 0, 4, 800).opacity).toBe(1);
    expect(coinFrame(COINS[0], 0, 5, 800).opacity).toBe(0);
  });

  it("staggers each coin's motion", () => {
    expect(coinFrame(COINS[0], 0, 3, 800).transition).not.toBe(coinFrame(COINS[5], 5, 3, 800).transition);
  });

  it("labels each coin with its token glyph", () => {
    expect(coinFrame(COINS[0], 0, 3, 800).glyph).toBe("$");
    expect(coinFrame(COINS[1], 1, 3, 800).glyph).toBe("ℏ");
    expect(coinFrame(COINS[3], 3, 3, 800).glyph).toBe("Ξ");
  });
});
