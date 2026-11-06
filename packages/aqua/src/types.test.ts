import { describe, expect, it } from "vitest";
import { LENDER_TIERS, tierArgs } from "./types.js";

const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

describe("LENDER_TIERS", () => {
  it("matches the D-A2 tier table", () => {
    expect(LENDER_TIERS).toEqual({
      low: { aprBps: 700, minSellerOnTime: 3, maxSellerDefaults: 0, minBuyerOnTime: 0, maxTenorDays: 60, maxAdvanceBps: 8000 },
      medium: { aprBps: 850, minSellerOnTime: 1, maxSellerDefaults: 0, minBuyerOnTime: 0, maxTenorDays: 60, maxAdvanceBps: 8000 },
      high: { aprBps: 1300, minSellerOnTime: 0, maxSellerDefaults: 2, minBuyerOnTime: 0, maxTenorDays: 60, maxAdvanceBps: 8000 },
    });
    expect(Object.isFrozen(LENDER_TIERS.low)).toBe(true);
  });
});

describe("tierArgs", () => {
  it("defaults to 5 USDC per buyer, no reserve and any seller", () => {
    expect(tierArgs("high")).toEqual({
      aprBps: 1300,
      minSellerOnTime: 0,
      maxSellerDefaults: 2,
      minBuyerOnTime: 0,
      maxTenorDays: 60,
      maxAdvanceBps: 8000,
      maxPerBuyer: 5_000_000n,
      minReserve: 0n,
      sellerSet: [],
    });
  });

  it("takes the lender's seller set, cap and reserve", () => {
    const set: `0x${string}`[] = [SELLER];
    const a = tierArgs("low", { sellerSet: set, maxPerBuyer: 2_000_000n, minReserve: 1_000_000n });
    expect(a).toMatchObject({ aprBps: 700, minSellerOnTime: 3, sellerSet: [SELLER], maxPerBuyer: 2_000_000n, minReserve: 1_000_000n });
    expect(a.sellerSet).not.toBe(set);
  });

  it("rejects more than three sellers", () => {
    expect(() => tierArgs("medium", { sellerSet: [SELLER, SELLER, SELLER, SELLER] })).toThrow(/at most 3/);
  });
});
