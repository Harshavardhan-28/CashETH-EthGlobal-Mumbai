import { describe, expect, it } from "vitest";
import { backingOf, formatRate, rateRange, SLABS, slabLabel } from "./slabs";

const SELLER = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";

describe("slabs", () => {
  it("names each slab with the scores it covers and its rate range", () => {
    expect(SLABS.low).toEqual({ label: "Low risk", scores: "700–750", rates: "6–8%" });
    expect(SLABS.medium).toEqual({ label: "Medium risk", scores: "600–699", rates: "8–11%" });
    expect(SLABS.high).toEqual({ label: "High risk", scores: "500–599", rates: "11–14%" });
    expect(slabLabel("medium")).toBe("Medium risk");
    expect(slabLabel("none")).toBe("Not financeable");
  });

  it("formats a rate in basis points as a percentage, and no rate as a dash", () => {
    expect(formatRate(1010)).toBe("10.1%");
    expect(formatRate(600)).toBe("6%");
    expect(formatRate(0)).toBe("—");
  });

  it("says whether a lender backs a seller: its slab must be funded and, with a seller list, the seller listed", () => {
    const open = { slabs: ["low", "medium"] as const, sellers: [] };
    expect(backingOf(open, { address: SELLER, slab: "medium" })).toBe("backed");
    expect(backingOf(open, { address: SELLER, slab: "high" })).toBe("outside-slabs");
    expect(backingOf({ slabs: ["medium"], sellers: [OTHER] }, { address: SELLER, slab: "medium" })).toBe("not-listed");
    expect(backingOf({ slabs: ["medium"], sellers: [SELLER.toUpperCase().replace("0X", "0x")] }, { address: SELLER, slab: "medium" })).toBe("backed");
    expect(backingOf(open, { address: SELLER, slab: "none" })).toBe("not-financeable");
    expect(backingOf(undefined, { address: SELLER, slab: "low" })).toBe("outside-slabs");
  });

  it("gives the rate range a lender's funded slabs can earn", () => {
    expect(rateRange(["low", "medium"])).toBe("6–11%");
    expect(rateRange(["high"])).toBe("11–14%");
    expect(rateRange(["low", "high"])).toBe("6–8% or 11–14%");
    expect(rateRange([])).toBe("—");
  });
});
