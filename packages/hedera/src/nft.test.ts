import { describe, expect, it } from "vitest";
import { encodeReceivableMetadata, serialFromReceipt } from "./nft.js";

const id32 = `0x${"ab".repeat(32)}`;

describe("encodeReceivableMetadata", () => {
  it("stays within 100 bytes for a 32-byte id and a 6-digit seq", () => {
    const bytes = encodeReceivableMetadata({ id: id32, hcsSeq: 999_999 });
    expect(bytes.length).toBeLessThanOrEqual(100);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ id: id32, seq: 999_999 });
  });

  it("throws above the 100-byte HTS metadata limit", () => {
    expect(() => encodeReceivableMetadata({ id: `0x${"ab".repeat(48)}`, hcsSeq: 1 })).toThrow(
      /100 bytes/,
    );
  });
});

describe("serialFromReceipt", () => {
  it("reads the first serial from a receipt whose serials are Long-like", () => {
    expect(serialFromReceipt({ serials: [{ toNumber: () => 7 }] })).toBe(7);
  });

  it("accepts plain numbers and bigints", () => {
    expect(serialFromReceipt({ serials: [3] })).toBe(3);
    expect(serialFromReceipt({ serials: [12n] })).toBe(12);
  });

  it("throws when the receipt carries no serial", () => {
    expect(() => serialFromReceipt({ serials: [] })).toThrow(/no serial/);
  });
});
