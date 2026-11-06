import { describe, expect, it } from "vitest";
import { pickUsdcSource, type UsdcSource } from "./funding.js";

const src = (name: string, balance: bigint): UsdcSource => ({ name, id: `0.0.${name}`, key: "k", balance });

describe("pickUsdcSource", () => {
  it("prefers the configured source when it holds enough", () => {
    const merchant = src("merchant", 10_000_000n);
    expect(pickUsdcSource(10_000_000n, merchant, src("operator", 99_000_000n))).toBe(merchant);
  });

  it("falls back to the operator when the configured source is short", () => {
    const operator = src("operator", 10_000_000n);
    expect(pickUsdcSource(10_000_000n, src("merchant", 0n), operator)).toBe(operator);
  });

  it("throws naming the shortfall when neither source suffices", () => {
    expect(() => pickUsdcSource(10_000_000n, src("merchant", 500_000n), src("operator", 2_400_000n))).toThrow(
      /need 10000000 units.*merchant.*500000.*operator.*2400000.*short by 7600000/,
    );
  });
});
