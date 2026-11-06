import { describe, expect, it } from "vitest";
import { formatUsdc, humanizeCode, initials, relativeTime, shortAddress } from "./format";

describe("formatUsdc", () => {
  it("formats base units with 2 decimals", () => {
    expect(formatUsdc("800000000")).toBe("$800.00");
    expect(formatUsdc("800000")).toBe("$0.80");
    expect(formatUsdc("0")).toBe("$0.00");
    expect(formatUsdc("5")).toBe("$0.00");
  });
  it("truncates without float loss", () => {
    expect(formatUsdc("123456789012345678")).toBe("$123,456,789,012.34");
    expect(formatUsdc("999999")).toBe("$0.99");
  });
  it("returns a dash for garbage", () => {
    expect(formatUsdc("abc")).toBe("—");
    expect(formatUsdc("")).toBe("—");
    expect(formatUsdc("-5")).toBe("—");
    expect(formatUsdc("1.5")).toBe("—");
    expect(formatUsdc(undefined)).toBe("—");
  });
});

describe("shortAddress", () => {
  it("shortens an EVM address", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
  it("leaves short strings alone", () => {
    expect(shortAddress("0x12")).toBe("0x12");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  it("renders units", () => {
    expect(relativeTime("2026-11-07T11:59:56Z", now)).toBe("4s ago");
    expect(relativeTime("2026-11-07T11:59:59.5Z", now)).toBe("just now");
    expect(relativeTime("2026-11-07T11:58:00Z", now)).toBe("2m ago");
    expect(relativeTime("2026-11-07T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-11-05T12:00:00Z", now)).toBe("2d ago");
  });
  it("treats future and invalid times safely", () => {
    expect(relativeTime("2026-11-07T12:00:30Z", now)).toBe("just now");
    expect(relativeTime("not a date", now)).toBe("—");
  });
});

describe("initials", () => {
  it("builds initials", () => {
    expect(initials("Worker 1")).toBe("W1");
    expect(initials("Lender A")).toBe("LA");
    expect(initials("Seller")).toBe("S");
    expect(initials("")).toBe("?");
  });
});

describe("humanizeCode", () => {
  it("maps known codes", () => {
    expect(humanizeCode("AGENT_BUDGET_EXCEEDED")).toBe("Over its budget");
    expect(humanizeCode("TX_LIMIT_EXCEEDED")).toBe("Above its per-payment limit");
    expect(humanizeCode("MERCHANT_URL_NOT_ALLOWED")).toBe("Merchant not on its allow-list");
    expect(humanizeCode("RESERVATION_EXPIRED")).toBe("Reservation expired");
  });
  it("falls back to sentence case", () => {
    expect(humanizeCode("SOME_NEW_CODE")).toBe("Some new code");
  });
});
