/** On-chain KYA reputation counters of the buyer (`KYARegistry.reputation`). */
export type BuyerReputation = { onTime: number; late: number; defaults: number };

export type ScoreInput = {
  /** Receivable face value in USDC base units (6 decimals). */
  amount: bigint;
  /** Unix seconds. */
  dueDate: bigint;
  /** Unix seconds. */
  now: bigint;
  buyerReputation: BuyerReputation;
  sellerLevel: number;
  buyerLevel: number;
};

export type Decision = {
  approved: boolean;
  score: number;
  advanceBps: number;
  /** Most the facility may advance, in USDC base units. */
  limit: bigint;
  /** Why the receivable was declined; empty when approved. */
  reasons: string[];
};

const BASE_SCORE = 600;
const ON_TIME_POINTS = 15;
const ON_TIME_CAP = 10;
const LATE_PENALTY = 40;
const DEFAULT_PENALTY = 200;
const LONG_TENOR_PENALTY = 50;
const LONG_TENOR_SECONDS = 60n * 86_400n;
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
 * Deterministic credit decision for a receivable: base 600, +15 per on-time repayment (at most 10),
 * -40 per late repayment, -200 per default, -50 when the tenor exceeds 60 days; the score picks the
 * advance rate and the seller's KYA level caps the limit.
 */
export function scoreReceivable(input: ScoreInput): Decision {
  const { onTime, late, defaults } = input.buyerReputation;
  let score = BASE_SCORE + ON_TIME_POINTS * Math.min(onTime, ON_TIME_CAP) - LATE_PENALTY * late - DEFAULT_PENALTY * defaults;
  if (input.dueDate - input.now > LONG_TENOR_SECONDS) score -= LONG_TENOR_PENALTY;

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
    advanceBps,
    limit: advance < cap ? advance : cap,
    reasons,
  };
}
