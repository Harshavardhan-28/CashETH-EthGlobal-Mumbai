import { describe, expect, it } from "vitest";
import { HFS_CHUNK_BYTES, hfsTransactionCount } from "./hfs.js";

describe("hfsTransactionCount", () => {
  it("is one create, plus one append per further chunk", () => {
    expect(hfsTransactionCount(0)).toBe(1);
    expect(hfsTransactionCount(HFS_CHUNK_BYTES)).toBe(1);
    expect(hfsTransactionCount(HFS_CHUNK_BYTES + 1)).toBe(2);
    expect(hfsTransactionCount(2 * 1024 * 1024)).toBe(512);
  });
});
