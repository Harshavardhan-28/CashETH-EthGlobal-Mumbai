/**
 * The seller's credit score, risk slab and APR. Mirrors `contracts/src/core/libs/RiskPricing.sol`, which the credit
 * opcode runs on every fill; both are tested against the same table, so the server always quotes the rate the
 * chain will charge.
 *
 * Score: 600, +15 per on-time repayment (at most 10), -40 per late one, -200 per default, -50 when the tenor is over
 * 60 days. Slabs: low risk 700 and up, medium 600-699, high 500-599; below 500 is not financeable. The APR is
 * piecewise linear through (750, 6%), (700, 8%), (600, 11%), (500, 14%), so a slightly better score always pays
 * slightly less, with no jump at a slab boundary.
 */

/** On-chain KYA reputation counters (`KYARegistry.reputation`). */
export type Reputation = { onTime: number; late: number; defaults: number };

export type Slab = "low" | "medium" | "high" | "none";

const BASE_SCORE = 600;
const ON_TIME_POINTS = 15;
const ON_TIME_CAP = 10;
const LATE_PENALTY = 40;
const DEFAULT_PENALTY = 200;
const LONG_TENOR_PENALTY = 50;
const LONG_TENOR_SECONDS = 60n * 86_400n;

export const MIN_FINANCEABLE_SCORE = 500;

/** Score -> APR breakpoints, best score first. */
const APR_CURVE: readonly (readonly [score: number, aprBps: number])[] = [
  [750, 600],
  [700, 800],
  [600, 1100],
  [MIN_FINANCEABLE_SCORE, 1400],
];

export function creditScore(rep: Reputation, tenorSeconds: bigint): number {
  let score = BASE_SCORE + ON_TIME_POINTS * Math.min(rep.onTime, ON_TIME_CAP) - LATE_PENALTY * rep.late - DEFAULT_PENALTY * rep.defaults;
  if (tenorSeconds > LONG_TENOR_SECONDS) score -= LONG_TENOR_PENALTY;
  return score;
}

export function slabOf(score: number): Slab {
  if (score >= 700) return "low";
  if (score >= 600) return "medium";
  if (score >= MIN_FINANCEABLE_SCORE) return "high";
  return "none";
}

/** The APR in basis points (floored), or undefined below the financeable score. */
export function aprBpsFor(score: number): number | undefined {
  if (score < MIN_FINANCEABLE_SCORE) return undefined;
  const [best, bestApr] = APR_CURVE[0]!;
  if (score >= best) return bestApr;
  for (let i = 1; i < APR_CURVE.length; i++) {
    const [from, aprFrom] = APR_CURVE[i]!;
    const [to, aprTo] = APR_CURVE[i - 1]!;
    if (score >= from) return aprFrom - Math.floor(((aprFrom - aprTo) * (score - from)) / (to - from));
  }
  return undefined;
}
