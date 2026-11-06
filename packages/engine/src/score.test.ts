import { describe, expect, it } from "vitest";
import { scoreReceivable, type ScoreInput } from "./score.js";

const NOW = 1_750_000_000n;
const DAY = 86_400n;
const USDC = 1_000_000n;

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    amount: 10n * USDC,
    dueDate: NOW + 30n * DAY,
    now: NOW,
    buyerReputation: { onTime: 0, late: 0, defaults: 0 },
    sellerLevel: 2,
    buyerLevel: 3,
    ...over,
  };
}

const withHistory = (onTime: number, late: number, defaults = 0) =>
  scoreReceivable(input({ buyerReputation: { onTime, late, defaults } }));

describe("scoreReceivable", () => {
  it("demo buyer with zero history scores 600 and gets 7500 bps", () => {
    const d = scoreReceivable(input());
    expect(d).toEqual({ approved: true, score: 600, advanceBps: 7500, limit: 7_500_000n, reasons: [] });
  });

  it("one default declines", () => {
    const d = withHistory(0, 0, 1);
    expect(d.score).toBe(400);
    expect(d.advanceBps).toBe(0);
    expect(d.approved).toBe(false);
    expect(d.limit).toBe(0n);
    expect(d.reasons).toContain("score 400 below 500");
  });

  it("level-2 seller limit caps at 1000 USDC", () => {
    const d = scoreReceivable(input({ amount: 5_000n * USDC, sellerLevel: 2 }));
    expect(d.advanceBps).toBe(7500);
    expect(d.limit).toBe(1_000n * USDC);

    // A level-3 seller gets the advance up to 10,000 USDC.
    expect(scoreReceivable(input({ amount: 5_000n * USDC, sellerLevel: 3 })).limit).toBe(3_750n * USDC);
    expect(scoreReceivable(input({ amount: 100_000n * USDC, sellerLevel: 3 })).limit).toBe(10_000n * USDC);
  });

  it("tenor over 60 days costs 50 points", () => {
    expect(scoreReceivable(input({ dueDate: NOW + 60n * DAY })).score).toBe(600);
    const d = scoreReceivable(input({ dueDate: NOW + 60n * DAY + 1n }));
    expect(d.score).toBe(550);
    expect(d.advanceBps).toBe(6000);
    expect(d.reasons).toEqual([]);
  });

  it("on-time repayments add 15 points each up to 10, late ones cost 40", () => {
    expect(withHistory(7, 0).score).toBe(705);
    expect(withHistory(25, 0).score).toBe(750);
    expect(withHistory(2, 3).score).toBe(510);
  });

  it("maps the score to the advance at 700 / 600 / 500", () => {
    expect(withHistory(7, 0).advanceBps).toBe(8000); // 705
    expect(withHistory(6, 0).advanceBps).toBe(7500); // 690
    expect(withHistory(0, 2).advanceBps).toBe(6000); // 520
    expect(withHistory(0, 3).advanceBps).toBe(0); // 480
    expect(withHistory(0, 3).approved).toBe(false);
  });

  it("approval needs a level-3 buyer and a level-2 seller", () => {
    const lowBuyer = scoreReceivable(input({ buyerLevel: 2 }));
    expect(lowBuyer.approved).toBe(false);
    expect(lowBuyer.reasons).toEqual(["buyer KYA level 2 below 3"]);
    const lowSeller = scoreReceivable(input({ sellerLevel: 1 }));
    expect(lowSeller.approved).toBe(false);
    expect(lowSeller.reasons).toEqual(["seller KYA level 1 below 2"]);
  });
});
