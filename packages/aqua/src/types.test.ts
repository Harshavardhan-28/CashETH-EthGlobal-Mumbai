import { describe, expect, it } from "vitest";
import { creditArgs, slabMask, slabsOf } from "./types.js";

const SELLER = "0x00000000000000000000000000000000000000a1";

describe("slab masks", () => {
  it("packs the funded slabs into the opcode's bit mask (low 1, medium 2, high 4)", () => {
    expect(slabMask(["low"])).toBe(1);
    expect(slabMask(["medium", "high"])).toBe(6);
    expect(slabMask(["high", "low", "medium", "low"])).toBe(7);
    expect(() => slabMask([])).toThrow(/at least one slab/);
  });

  it("reads a mask back as slabs, safest first", () => {
    expect(slabsOf(5)).toEqual(["low", "high"]);
    expect(slabsOf(7)).toEqual(["low", "medium", "high"]);
  });
});

describe("creditArgs", () => {
  it("defaults to a 60-day tenor, an 80% advance, a 5 USDC per-buyer cap and no reserve", () => {
    expect(creditArgs(["medium"])).toEqual({
      maxTenorDays: 60,
      maxAdvanceBps: 8000,
      maxPerBuyer: 5_000_000n,
      slabMask: 2,
      minReserve: 0n,
      sellerSet: [],
    });
  });

  it("takes the lender's chosen sellers, per-buyer cap and reserve", () => {
    const a = creditArgs(["low", "medium"], { sellerSet: [SELLER], maxPerBuyer: 2_000_000n, minReserve: 1_000_000n });
    expect(a).toMatchObject({ slabMask: 3, sellerSet: [SELLER], maxPerBuyer: 2_000_000n, minReserve: 1_000_000n });
  });

  it("allows at most 3 sellers", () => {
    expect(() => creditArgs(["high"], { sellerSet: [SELLER, SELLER, SELLER, SELLER] })).toThrow(/at most 3/);
  });
});
