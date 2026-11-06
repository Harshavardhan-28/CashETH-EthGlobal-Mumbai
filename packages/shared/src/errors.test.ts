import { describe, expect, it } from "vitest";
import { ERROR_CODES, isErrorCode } from "./errors.js";

describe("isErrorCode", () => {
  it("isErrorCode('DUPLICATE_RECEIVABLE') is true", () => {
    expect(isErrorCode("DUPLICATE_RECEIVABLE")).toBe(true);
  });

  it("isErrorCode('nope') is false", () => {
    expect(isErrorCode("nope")).toBe(false);
  });

  it("knows the credit-opcode, spend and repayment revert names", () => {
    for (const code of [
      "SELLER_NOT_FUNDED_BY_LENDER",
      "LENDER_RESERVE_TOO_LOW",
      "NOT_PARTY",
      "WALLET_BUSY",
      "BUDGET_BELOW_USED",
      "BUDGETS_EXCEED_FUNDED",
      "RESERVATION_EXISTS",
      "RESERVATION_NOT_OPEN",
      "NOT_DUE",
      "NOT_FINANCED",
      "ZERO_AMOUNT",
    ]) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it("knows the auth-server identity codes", () => {
    for (const code of ["KYA_FAIL", "KYA_LEVEL_TOO_LOW", "UAID_MISMATCH"]) expect(isErrorCode(code), code).toBe(true);
  });

  it("has no duplicate codes", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
