/**
 * The numbers of the demo, in one place: who lends what, what is borrowed, spent, refused and repaid. Resizing
 * the demo means editing this file only: the expected fills and payouts are derived from it, and the steps and
 * the tests read them from here.
 */
import type { RiskSlab } from "@casheth/aqua";
import { parseUnits, type Address } from "viem";
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

/**
 * The two lenders that ship a fresh credit strategy for the seller. They choose risk slabs, not a price: both
 * fund medium risk, where a seller with little history scores (600-699), and every fill pays the seller's own rate.
 */
export const FRESH_LENDERS: Record<FreshLender, { slabs: RiskSlab[]; creditUsdc: bigint; maxPerBuyer?: bigint }> = {
  // A's cap covers this receivable and an earlier one against the same buyer.
  A: { slabs: ["low", "medium"], creditUsdc: usdc("3.5"), maxPerBuyer: usdc("10") },
  B: { slabs: ["medium"], creditUsdc: usdc("1.5") },
};

export interface Fill {
  lender: FreshLender;
  amount: bigint;
}

/** What the solver funds: the largest strategy first (fewer fills), each up to its credit, until `base` is covered. */
export function expectedFills(base: bigint, lenders: Record<FreshLender, { creditUsdc: bigint }> = FRESH_LENDERS): Fill[] {
  const largestFirst = (Object.keys(lenders) as FreshLender[]).sort((a, b) => Number(lenders[b].creditUsdc - lenders[a].creditUsdc));
  let remaining = base;
  const fills: Fill[] = [];
  for (const lender of largestFirst) {
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

/** One lender position as `/receivables/:id` reports it: the principal and the seller's rate it was funded at. */
export type Position = { maker: Address; principal: string; aprBps: number };

/**
 * The repayment split when the buyer repays `amount` quickly: each lender its principal plus the minimum fee at
 * the rate its position recorded (the seller's own rate at funding), the seller the rest.
 */
export function expectedSplit(amount: bigint, positions: Position[], makers: Record<FreshLender, Address>): Record<FreshLender | "seller", bigint> {
  const payout = (lender: FreshLender): bigint => {
    const p = positions.find((x) => x.maker.toLowerCase() === makers[lender].toLowerCase());
    return p ? BigInt(p.principal) + lenderFee(BigInt(p.principal), p.aprBps) : 0n;
  };
  const A = payout("A");
  const B = payout("B");
  return { A, B, seller: amount - A - B };
}

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
