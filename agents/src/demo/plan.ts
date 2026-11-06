/**
 * The numbers of the demo, in one place: who lends what, what is borrowed, spent, refused and repaid. Resizing
 * the demo means editing this file only: the expected fills and payouts are derived from it, and the steps and
 * the tests read them from here.
 */
import { LENDER_TIERS, type Tier } from "@casheth/aqua";
import { parseUnits } from "viem";
import { INVOICE_PO_1003, INVOICE_PO_1003_DUE_UNIX, INVOICE_PO_1003_PDF } from "../fixtures.js";

/** USDC has 6 decimals. */
export const usdc = (amount: string): bigint => parseUnits(amount, 6);

const DAY = 86_400n;
const YEAR = 365n * DAY;
const BPS = 10_000n;
/** The RepaymentRouter charges at least 30 days of fee, however fast the buyer repays (Ruling R29). */
const MIN_FEE_SECONDS = 30n * DAY;

/** The terms are the ones the invoice PDF prints: the server refuses an upload whose terms differ from the file. */
export const INVOICE = {
  buyerRef: INVOICE_PO_1003.buyerRef,
  amount: INVOICE_PO_1003.amountUnits,
  dueDate: INVOICE_PO_1003_DUE_UNIX,
  file: INVOICE_PO_1003_PDF,
};

/** The credit decision the facility opens with: the facility borrows this share of the invoice. */
export const ADVANCE_BPS = 7500;
export const BORROWING_BASE = (INVOICE.amount * BigInt(ADVANCE_BPS)) / BPS;

export type FreshLender = "A" | "B";

/** The two lenders that ship a fresh credit strategy for the seller (their earlier ones funded PO-1002). */
export const FRESH_LENDERS: Record<FreshLender, { tier: Tier; creditUsdc: bigint; maxPerBuyer?: bigint }> = {
  // The buyer already owes lender A 3.5 USDC from PO-1002: the server's default 5 USDC per-buyer cap would leave
  // 1.5 USDC of headroom, so A's cap covers both receivables.
  A: { tier: "low", creditUsdc: usdc("3.5"), maxPerBuyer: usdc("10") },
  B: { tier: "medium", creditUsdc: usdc("1.5") },
};

const aprBpsOf = (lender: FreshLender): number => LENDER_TIERS[FRESH_LENDERS[lender].tier].aprBps;

export interface Fill {
  lender: FreshLender;
  amount: bigint;
}

/** What the cheapest-first solver funds: the lowest APR first, each up to its credit, until `base` is covered. */
export function expectedFills(base: bigint, lenders = FRESH_LENDERS): Fill[] {
  const cheapestFirst = (Object.keys(lenders) as FreshLender[]).sort((a, b) => aprBpsOf(a) - aprBpsOf(b));
  let remaining = base;
  const fills: Fill[] = [];
  for (const lender of cheapestFirst) {
    const amount = remaining < lenders[lender].creditUsdc ? remaining : lenders[lender].creditUsdc;
    if (amount === 0n) continue;
    fills.push({ lender, amount });
    remaining -= amount;
  }
  return fills;
}

/** The RepaymentRouter's lender fee: `principal * aprBps * max(elapsed, 30 days) / (365 days * 10_000)`, rounded down. */
export function lenderFee(principal: bigint, aprBps: number, elapsedSeconds = 0n): bigint {
  const charged = elapsedSeconds > MIN_FEE_SECONDS ? elapsedSeconds : MIN_FEE_SECONDS;
  return (principal * BigInt(aprBps) * charged) / (YEAR * BPS);
}

export const EXPECTED_FILLS = expectedFills(BORROWING_BASE);

/** What each lender is paid when the buyer repays the whole invoice quickly: its principal plus the minimum fee. */
export function expectedPayouts(fills: Fill[]): Record<FreshLender, bigint> {
  const payout = (lender: FreshLender): bigint => {
    const principal = fills.find((f) => f.lender === lender)?.amount ?? 0n;
    return principal + lenderFee(principal, aprBpsOf(lender));
  };
  return { A: payout("A"), B: payout("B") };
}

export const EXPECTED_PAYOUTS = expectedPayouts(EXPECTED_FILLS);

/** Lenders are paid first; the seller receives the rest of the repayment. */
export const EXPECTED_SELLER_PAYOUT = INVOICE.amount - EXPECTED_PAYOUTS.A - EXPECTED_PAYOUTS.B;

/** Per-worker facility budgets. What the workers are not allocated stays as the facility's headroom. */
export const BUDGETS = {
  research: { alloc: usdc("1"), maxPerTx: usdc("0.5"), maxDaily: usdc("2") },
  compute: { alloc: usdc("3"), maxPerTx: usdc("3"), maxDaily: usdc("3") },
};

/**
 * The first attempt number that is certainly unused for the research purchase (earlier launches used 1 and 2). The
 * runner adds the number of reservations this worker has had released, so a reservation freed after it expired
 * unpaid is never replayed and a rerun after a committed purchase still replays it.
 */
export const PURCHASE_ATTEMPT_BASE = 2;

/** The research worker's purchase and the two over-limit asks that must be refused (Ruling R24). */
export const SPEND = {
  researchPrice: usdc("0.25"),
  researchOverLimit: usdc("0.6"),
  computeOverBudget: usdc("5.5"),
};
