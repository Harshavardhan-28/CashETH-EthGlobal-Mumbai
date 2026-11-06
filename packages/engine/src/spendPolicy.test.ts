import { describe, expect, it } from "vitest";
import { checkSpend, type Budget, type Mandate } from "./spendPolicy.js";

type Input = Parameters<typeof checkSpend>[0];

const MERCHANT = "0x00000000000000000000000000000000000ad3b8" as const;
const OTHER = "0x0000000000000000000000000000000000000bad" as const;
const DAY0 = 1_700_000_000n;

function budget(over: Partial<Budget> = {}): Budget {
  return {
    alloc: 10_000_000n,
    spent: 0n,
    reserved: 0n,
    maxPerTx: 2_000_000n,
    maxDaily: 5_000_000n,
    dailySpent: 0n,
    dayStart: DAY0,
    ...over,
  };
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return { maxPerTx: 2_000_000n, maxDaily: 5_000_000n, merchants: [MERCHANT], ...over };
}

function input(over: Partial<Input> = {}): Input {
  return {
    amount: 250_000n,
    budget: budget(),
    available: 100_000_000n,
    mandate: mandate(),
    merchant: MERCHANT,
    now: DAY0 + 60n,
    facilityActive: true,
    paused: false,
    ...over,
  };
}

describe("checkSpend", () => {
  it("approves a spend inside every limit", () => {
    expect(checkSpend(input())).toEqual({ ok: true });
  });

  it("rejects PAUSED first, even when the facility is inactive and over budget", () => {
    expect(
      checkSpend(input({ paused: true, facilityActive: false, amount: 99_000_000n })),
    ).toEqual({ ok: false, code: "PAUSED" });
  });

  it("rejects FACILITY_NOT_ACTIVE before budget checks", () => {
    expect(checkSpend(input({ facilityActive: false, amount: 99_000_000n }))).toEqual({
      ok: false,
      code: "FACILITY_NOT_ACTIVE",
    });
  });

  it("rejects the demo compute spend of 5.5 USDC against a 3 USDC budget", () => {
    const res = checkSpend(
      input({
        amount: 5_500_000n,
        budget: budget({ alloc: 3_000_000n, spent: 0n, reserved: 0n }),
      }),
    );
    expect(res).toEqual({ ok: false, code: "AGENT_BUDGET_EXCEEDED" });
  });

  it("counts spent and reserved against the allocation", () => {
    const b = budget({ alloc: 1_000_000n, spent: 400_000n, reserved: 400_000n });
    expect(checkSpend(input({ budget: b, amount: 200_000n }))).toEqual({ ok: true });
    expect(checkSpend(input({ budget: b, amount: 200_001n }))).toEqual({
      ok: false,
      code: "AGENT_BUDGET_EXCEEDED",
    });
  });

  it("reports a budget failure before a limit failure when both apply", () => {
    // 3_000_000 exceeds alloc (1_000_000), maxPerTx (2_000_000), and the merchant is not allowed.
    const res = checkSpend(
      input({ amount: 3_000_000n, budget: budget({ alloc: 1_000_000n }), merchant: OTHER }),
    );
    expect(res).toEqual({ ok: false, code: "AGENT_BUDGET_EXCEEDED" });
  });

  it("rejects TX_LIMIT_EXCEEDED using the stricter of budget and mandate maxPerTx", () => {
    const strictMandate = mandate({ maxPerTx: 100_000n });
    expect(checkSpend(input({ mandate: strictMandate, amount: 100_000n }))).toEqual({ ok: true });
    expect(checkSpend(input({ mandate: strictMandate, amount: 100_001n }))).toEqual({
      ok: false,
      code: "TX_LIMIT_EXCEEDED",
    });
    const strictBudget = budget({ maxPerTx: 100_000n });
    expect(checkSpend(input({ budget: strictBudget, amount: 100_001n }))).toEqual({
      ok: false,
      code: "TX_LIMIT_EXCEEDED",
    });
  });

  it("reports a per-tx failure before a daily failure when both apply", () => {
    const b = budget({ dailySpent: 5_000_000n });
    expect(checkSpend(input({ budget: b, amount: 2_000_001n }))).toEqual({
      ok: false,
      code: "TX_LIMIT_EXCEEDED",
    });
  });

  it("treats a zero or negative amount as TX_LIMIT_EXCEEDED", () => {
    expect(checkSpend(input({ amount: 0n }))).toEqual({ ok: false, code: "TX_LIMIT_EXCEEDED" });
    expect(checkSpend(input({ amount: -1n }))).toEqual({ ok: false, code: "TX_LIMIT_EXCEEDED" });
  });

  it("rejects DAILY_LIMIT_EXCEEDED using the stricter of budget and mandate maxDaily", () => {
    const b = budget({ dailySpent: 4_900_000n });
    expect(checkSpend(input({ budget: b, amount: 100_000n }))).toEqual({ ok: true });
    expect(checkSpend(input({ budget: b, amount: 100_001n }))).toEqual({
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
    });
    const m = mandate({ maxDaily: 1_000_000n });
    expect(
      checkSpend(input({ budget: budget({ dailySpent: 900_000n }), mandate: m, amount: 100_001n })),
    ).toEqual({ ok: false, code: "DAILY_LIMIT_EXCEEDED" });
  });

  it("resets the daily counter once 86400 seconds have passed since dayStart", () => {
    const b = budget({ dailySpent: 5_000_000n });
    expect(checkSpend(input({ budget: b, now: DAY0 + 86_399n }))).toEqual({
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
    });
    expect(checkSpend(input({ budget: b, now: DAY0 + 86_400n }))).toEqual({ ok: true });
  });

  it("checks the daily limit before the merchant allow-list", () => {
    const b = budget({ dailySpent: 5_000_000n });
    expect(checkSpend(input({ budget: b, merchant: OTHER }))).toEqual({
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
    });
  });

  it("rejects MERCHANT_NOT_ALLOWED and compares addresses case-insensitively", () => {
    expect(checkSpend(input({ merchant: OTHER }))).toEqual({
      ok: false,
      code: "MERCHANT_NOT_ALLOWED",
    });
    const upper = MERCHANT.replace("ad3b8", "AD3B8") as `0x${string}`;
    expect(checkSpend(input({ merchant: upper }))).toEqual({ ok: true });
  });

  it("checks the merchant allow-list before global availability", () => {
    expect(checkSpend(input({ merchant: OTHER, available: 0n }))).toEqual({
      ok: false,
      code: "MERCHANT_NOT_ALLOWED",
    });
  });

  it("rejects GLOBAL_CREDIT_LIMIT_EXCEEDED when the amount fits the budget but not the facility", () => {
    expect(checkSpend(input({ amount: 250_000n, available: 249_999n }))).toEqual({
      ok: false,
      code: "GLOBAL_CREDIT_LIMIT_EXCEEDED",
    });
    expect(checkSpend(input({ amount: 250_000n, available: 250_000n }))).toEqual({ ok: true });
  });
});
