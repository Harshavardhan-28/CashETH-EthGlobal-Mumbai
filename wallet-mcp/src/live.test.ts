import type { Env } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import { approveCap } from "./live.js";

const env = (value?: string) => (value === undefined ? {} : { WALLET_APPROVE_CAP_USDC: value }) as unknown as Env;

describe("approveCap (WALLET_APPROVE_CAP_USDC)", () => {
  it("defaults to 20 USDC in base units", () => {
    expect(approveCap(env())).toBe(20_000_000n);
  });

  it("reads a decimal USDC amount", () => {
    expect(approveCap(env("6.5"))).toBe(6_500_000n);
  });

  it("refuses a cap that is not a positive amount", () => {
    for (const bad of ["0", "-1", "lots"]) expect(() => approveCap(env(bad))).toThrow(/WALLET_APPROVE_CAP_USDC/);
  });
});
