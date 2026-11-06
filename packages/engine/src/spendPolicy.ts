import type { ErrorCode } from "@casheth/shared";

/** Mirrors the on-chain per-agent budget struct. `dayStart` is unix seconds. */
export type Budget = {
  alloc: bigint;
  spent: bigint;
  reserved: bigint;
  maxPerTx: bigint;
  maxDaily: bigint;
  dailySpent: bigint;
  dayStart: bigint;
};

export type Mandate = {
  maxPerTx: bigint;
  maxDaily: bigint;
  merchants: `0x${string}`[];
};

export type CheckSpendInput = {
  amount: bigint;
  budget: Budget;
  available: bigint;
  mandate: Mandate;
  merchant: `0x${string}`;
  now: bigint;
  facilityActive: boolean;
  paused: boolean;
};

export type CheckSpendResult = { ok: true } | { ok: false; code: ErrorCode };

const DAY_SECONDS = 86_400n;

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Pre-flight spend check, in the same order as the contract's reserve path. */
export function checkSpend(input: CheckSpendInput): CheckSpendResult {
  const { amount, budget, available, mandate, merchant, now } = input;

  if (input.paused) return { ok: false, code: "PAUSED" };
  if (!input.facilityActive) return { ok: false, code: "FACILITY_NOT_ACTIVE" };

  if (amount > budget.alloc - budget.spent - budget.reserved) {
    return { ok: false, code: "AGENT_BUDGET_EXCEEDED" };
  }

  if (amount <= 0n || amount > min(budget.maxPerTx, mandate.maxPerTx)) {
    return { ok: false, code: "TX_LIMIT_EXCEEDED" };
  }

  const dailySpent = now >= budget.dayStart + DAY_SECONDS ? 0n : budget.dailySpent;
  if (dailySpent + amount > min(budget.maxDaily, mandate.maxDaily)) {
    return { ok: false, code: "DAILY_LIMIT_EXCEEDED" };
  }

  const wanted = merchant.toLowerCase();
  if (!mandate.merchants.some((m) => m.toLowerCase() === wanted)) {
    return { ok: false, code: "MERCHANT_NOT_ALLOWED" };
  }

  if (amount > available) return { ok: false, code: "GLOBAL_CREDIT_LIMIT_EXCEEDED" };

  return { ok: true };
}
