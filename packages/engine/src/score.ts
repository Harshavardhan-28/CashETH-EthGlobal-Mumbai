import { aprBpsFor, creditScore, type Reputation, type Slab, slabOf } from "./pricing.js";

export type ScoreInput = {
  /** Receivable face value in USDC base units (6 decimals). */
  amount: bigint;
  /** Unix seconds. */
  dueDate: bigint;
  /** Unix seconds. */
  now: bigint;
  /** The seller's on-chain record: it prices the credit (`pricing.ts`). */
  sellerReputation: Reputation;
  sellerLevel: number;
  buyerLevel: number;
};

export type Decision = {
  approved: boolean;
  score: number;
  slab: Slab;
  /** The APR the credit opcode will charge, in basis points; 0 when the score is not financeable. */
  aprBps: number;
  advanceBps: number;
  /** Most the facility may advance, in USDC base units. */
  limit: bigint;
  /** Why the receivable was declined; empty when approved. */
  reasons: string[];
};

const MIN_BUYER_LEVEL = 3;
const MIN_SELLER_LEVEL = 2;
const SELLER_CAP_L3 = 10_000_000_000n; // 10,000 USDC
const SELLER_CAP = 1_000_000_000n; // 1,000 USDC

function advanceFor(score: number): number {
  if (score >= 700) return 8000;
  if (score >= 600) return 7500;
  if (score >= 500) return 6000;
  return 0;
}

/**
 * Deterministic credit decision for a receivable: the seller's score (`creditScore`: its record and the tenor) picks
 * the risk slab, the APR and the advance rate; the seller's KYA level caps the limit.
 */
export function scoreReceivable(input: ScoreInput): Decision {
  const score = creditScore(input.sellerReputation, input.dueDate - input.now);

  const advanceBps = advanceFor(score);
  const reasons: string[] = [];
  if (advanceBps === 0) reasons.push(`score ${score} below 500`);
  if (input.buyerLevel < MIN_BUYER_LEVEL) reasons.push(`buyer KYA level ${input.buyerLevel} below ${MIN_BUYER_LEVEL}`);
  if (input.sellerLevel < MIN_SELLER_LEVEL) {
    reasons.push(`seller KYA level ${input.sellerLevel} below ${MIN_SELLER_LEVEL}`);
  }

  const advance = (input.amount * BigInt(advanceBps)) / 10_000n;
  const cap = input.sellerLevel >= 3 ? SELLER_CAP_L3 : SELLER_CAP;
  return {
    approved: reasons.length === 0,
    score,
    slab: slabOf(score),
    aprBps: aprBpsFor(score) ?? 0,
    advanceBps,
    limit: advance < cap ? advance : cap,
    reasons,
  };
}
