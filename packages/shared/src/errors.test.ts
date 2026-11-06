import { describe, expect, it } from "vitest";
import { isErrorCode } from "./errors.js";

describe("isErrorCode", () => {
  it("isErrorCode('DUPLICATE_RECEIVABLE') is true", () => {
    expect(isErrorCode("DUPLICATE_RECEIVABLE")).toBe(true);
  });

  it("isErrorCode('nope') is false", () => {
    expect(isErrorCode("nope")).toBe(false);
  });
});
