import { describe, expect, it } from "vitest";
import { baseTakerData } from "./baseTakerData.js";

/** Ten slice end offsets (all equal when only the threshold slice is present), then the flags. */
const header = (sliceEnd: number, flags: number): string =>
  `${sliceEnd.toString(16).padStart(4, "0").repeat(10)}${flags.toString(16).padStart(4, "0")}`;

describe("baseTakerData", () => {
  it("packs exact-in A->B with a min-output threshold: flags exactIn | aquaPush | aToB, one 32-byte slice", () => {
    expect(baseTakerData({ isAToB: true, threshold: 5n })).toBe(`0x${header(32, 0x00c1)}${"05".padStart(64, "0")}`);
  });

  it("clears the A->B flag for B->A", () => {
    expect(baseTakerData({ isAToB: false, threshold: 5n })).toBe(`0x${header(32, 0x0041)}${"05".padStart(64, "0")}`);
  });

  it("has no threshold slice when the threshold is absent or zero", () => {
    expect(baseTakerData({ isAToB: true })).toBe(`0x${header(0, 0x00c1)}`);
    expect(baseTakerData({ isAToB: true, threshold: 0n })).toBe(`0x${header(0, 0x00c1)}`);
  });

  it("rejects a threshold that does not fit in 32 bytes or is negative", () => {
    expect(() => baseTakerData({ isAToB: true, threshold: 2n ** 256n })).toThrow(/threshold/);
    expect(() => baseTakerData({ isAToB: true, threshold: -1n })).toThrow(/threshold/);
  });
});
