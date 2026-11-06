/** The numbers of the demo (BUILD.md section 16): who lends what, what is borrowed, spent, rejected and repaid. */
import type { Tier } from "@casheth/aqua";
import { parseUnits } from "viem";

/** USDC has 6 decimals. */
export const usdc = (amount: string): bigint => parseUnits(amount, 6);

export const INVOICE = { buyerRef: "PO-1003", amount: usdc("8"), termDays: 30n };

/** The two lenders that ship a fresh credit strategy for the seller (their earlier ones funded PO-1002). */
export const FRESH_LENDERS: Record<"A" | "B", { tier: Tier; creditUsdc: bigint }> = {
  A: { tier: "low", creditUsdc: usdc("4") },
  B: { tier: "medium", creditUsdc: usdc("2") },
};

/** The credit decision the facility opens with (BUILD.md 7500 bps advance on PO-1003). */
export const ADVANCE_BPS = 7500;

/** What the cheapest-first solver must fund: lender A, then lender B. */
export const EXPECTED_FILLS = [
  { lender: "A", amount: usdc("4") },
  { lender: "B", amount: usdc("2") },
] as const;

/** Per-worker facility budgets. The 2 USDC the workers are not allocated stays as the facility's headroom. */
export const BUDGETS = {
  research: { alloc: usdc("1"), maxPerTx: usdc("0.5"), maxDaily: usdc("2") },
  compute: { alloc: usdc("3"), maxPerTx: usdc("3"), maxDaily: usdc("3") },
};

/** The research worker's purchase and the two over-limit asks that must be refused (Ruling R24). */
export const SPEND = {
  researchPrice: usdc("0.25"),
  researchOverLimit: usdc("0.6"),
  computeOverBudget: usdc("5.5"),
};

/** What lenders A and B are paid when the buyer repays the whole 8 USDC: principal plus the 30-day fee. */
export const EXPECTED_PAYOUTS = { A: 4_023_013n, B: 2_013_972n };
