/** Pure display helpers for the admin dashboard. Amount maths stays on decimal strings (no float loss). */

const DASH = "—";

/** USDC base units (6 decimals, decimal string) -> "$1,234.56", truncated to 2 decimals. */
export function formatUsdc(units: string | undefined): string {
  if (typeof units !== "string" || !/^\d+$/.test(units)) return DASH;
  const padded = units.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const cents = padded.slice(-6, -4);
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

export function shortAddress(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return DASH;
  const secs = Math.floor((nowMs - then) / 1000);
  if (secs < 2) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

const CODES: Record<string, string> = {
  AGENT_BUDGET_EXCEEDED: "Over its budget",
  TX_LIMIT_EXCEEDED: "Above its per-payment limit",
  DAILY_LIMIT_EXCEEDED: "Over its daily limit",
  MERCHANT_NOT_ALLOWED: "Merchant not on its allow-list",
  MERCHANT_URL_NOT_ALLOWED: "Merchant not on its allow-list",
  BAD_BUYER_SIG: "Buyer signature did not check out",
  KYA_FAIL: "Agent identity check failed",
  KYA_LEVEL_TOO_LOW: "Agent trust level too low",
  SELF_DEALING: "Seller and buyer are the same party",
  DUPLICATE_RECEIVABLE: "Invoice already financed",
  CREDIT_DECLINED: "Credit check declined",
  COSIGNER_REFUSED: "Payment co-signer refused",
  RESERVATION_EXPIRED: "Reservation expired",
};

/** Rejection code -> plain English; unknown codes become sentence case. */
export function humanizeCode(code: string): string {
  const known = CODES[code];
  if (known) return known;
  const text = code.replace(/_+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Credit score scale of `scoreReceivable` (packages/engine/src/score.ts), which `/agents` reports as `score`:
 * base 600, +15 per on-time repayment (at most 10), -40 per late one, -200 per default. With the zero tenor the
 * read API uses, the best possible score is 750; it can go below zero. It is not a percentage.
 */
export const SCORE_MAX = 750;

/** The advance band the engine gives a score (same thresholds as `advanceFor`). */
export function scoreBand(score: number): { label: string; advance: string; tone: "good" | "ok" | "warn" | "bad" } {
  if (!Number.isFinite(score)) return { label: "Unknown", advance: "—", tone: "warn" };
  if (score >= 700) return { label: "Excellent", advance: "80% advance", tone: "good" };
  if (score >= 600) return { label: "Good", advance: "75% advance", tone: "ok" };
  if (score >= 500) return { label: "Fair", advance: "60% advance", tone: "warn" };
  return { label: "Below 500", advance: "credit declined", tone: "bad" };
}

/** "630 / 750"; "—" for a missing or non-numeric score. */
export function formatScore(score: number): string {
  return Number.isFinite(score) ? `${Math.round(score)} / ${SCORE_MAX}` : DASH;
}

/** On-time repayment share, or "No history" when the agent has never repaid or defaulted (the API reports 0 then). */
export function formatOnTime(stats: { onTimePct: number; receivablesRepaid: number; receivablesDefaulted: number }): string {
  if (stats.receivablesRepaid + stats.receivablesDefaulted === 0 && !stats.onTimePct) return "No history";
  return Number.isFinite(stats.onTimePct) ? `${Math.round(stats.onTimePct)}%` : DASH;
}
