/**
 * Risk slabs of the credit pricing (`contracts/src/core/libs/RiskPricing.sol`, mirrored by
 * `packages/engine/src/pricing.ts`): a seller's score puts it in a slab, and its APR follows from the score on a
 * line through 750 = 6%, 700 = 8%, 600 = 11% and 500 = 14%. Lenders choose which slabs (and optionally which
 * sellers) they fund; they do not set the price.
 */
import type { Slab } from "./api";

export type FundedSlab = Exclude<Slab, "none">;

export const SLABS: Readonly<Record<FundedSlab, { label: string; scores: string; rates: string }>> = {
  low: { label: "Low risk", scores: "700–750", rates: "6–8%" },
  medium: { label: "Medium risk", scores: "600–699", rates: "8–11%" },
  high: { label: "High risk", scores: "500–599", rates: "11–14%" },
};

/** APR range of each slab, in percent; adjacent slabs share their boundary rate. */
const RATE_RANGE: Readonly<Record<FundedSlab, readonly [number, number]>> = { low: [6, 8], medium: [8, 11], high: [11, 14] };
const SAFEST_FIRST: readonly FundedSlab[] = ["low", "medium", "high"];

/** The rates a set of funded slabs can earn: "6–11%" for adjacent slabs, "6–8% or 11–14%" when there is a gap. */
export function rateRange(slabs: readonly FundedSlab[]): string {
  const ranges: [number, number][] = [];
  for (const slab of SAFEST_FIRST.filter((x) => slabs.includes(x))) {
    const [from, to] = RATE_RANGE[slab];
    const last = ranges.at(-1);
    if (last && last[1] === from) last[1] = to;
    else ranges.push([from, to]);
  }
  return ranges.length ? ranges.map(([from, to]) => `${from}–${to}%`).join(" or ") : "—";
}

export function slabLabel(slab: Slab): string {
  return slab === "none" ? "Not financeable" : SLABS[slab].label;
}

/** "10.1%" for 1010 basis points; "—" when there is no rate. */
export function formatRate(aprBps: number): string {
  return aprBps > 0 ? `${Number((aprBps / 100).toFixed(2))}%` : "—";
}

export type Backing = "backed" | "outside-slabs" | "not-listed" | "not-financeable";

/** Whether a lender's credit strategies would fund this seller now: its slab must be funded, and listed if the lender keeps a seller list. */
export function backingOf(
  lender: { slabs: readonly FundedSlab[]; sellers: readonly string[] } | undefined,
  seller: { address: string; slab: Slab },
): Backing {
  if (seller.slab === "none") return "not-financeable";
  if (!lender || !lender.slabs.includes(seller.slab)) return "outside-slabs";
  if (lender.sellers.length > 0 && !lender.sellers.some((a) => a.toLowerCase() === seller.address.toLowerCase())) return "not-listed";
  return "backed";
}
