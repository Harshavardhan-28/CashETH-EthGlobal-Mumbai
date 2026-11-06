/**
 * Deterministic checks on every tool call before it runs. The model proposes, this decides: a refused call never
 * reaches the MCP server or the buyer, and the refusal goes back to the model as the tool's answer.
 */
import type { Facts } from "./facts.js";

export interface GuardContext {
  facts: Facts;
  /** Per-run cap on USDC units reserved through `reserve_spend`. */
  spendCap: bigint;
  /** The only origin `pay_x402` may pay. */
  paidApiOrigin: string;
  /** Units approved for `reserve_spend` earlier in the same model turn (not yet in `facts.spent`). */
  pendingSpend: bigint;
}

export interface ProposedCall {
  name: string;
  args: Record<string, unknown>;
}

export type Refusal = { code: string; message: string };
export type Verdict = { ok: true } | { ok: false; refusal: Refusal };

const refuse = (code: string, message: string): Verdict => ({ ok: false, refusal: { code, message } });

const originOf = (url: unknown): string | undefined => {
  try {
    return new URL(String(url)).origin;
  } catch {
    return undefined;
  }
};

function checkReserve(args: Record<string, unknown>, { facts, spendCap, pendingSpend }: GuardContext): Verdict {
  if (typeof args.amount !== "string" || !/^[1-9]\d*$/.test(args.amount)) {
    return refuse("BAD_INPUT", "amount must be a positive whole number of USDC base units, as a string (\"500000\" is 0.50 USDC)");
  }
  const total = BigInt(facts.spent) + pendingSpend + BigInt(args.amount);
  if (total > spendCap) {
    return refuse("SPEND_CAP_EXCEEDED", `this run may reserve at most ${spendCap} units in total; ${facts.spent} are already reserved`);
  }
  return { ok: true };
}

function checkSpendUse(name: string, args: Record<string, unknown>, { facts, paidApiOrigin }: GuardContext): Verdict {
  if (!facts.spendIds.includes(String(args.spendId))) {
    return refuse("UNKNOWN_SPEND", `${name} only accepts a spendId that reserve_spend returned in this run`);
  }
  if (name === "pay_x402" && originOf(args.url) !== new URL(paidApiOrigin).origin) {
    return refuse("URL_NOT_ALLOWED", `pay_x402 only pays ${new URL(paidApiOrigin).origin}`);
  }
  return { ok: true };
}

export function guardCall({ name, args }: ProposedCall, context: GuardContext): Verdict {
  const { facts } = context;
  switch (name) {
    case "reserve_spend":
      return checkReserve(args, context);
    case "pay_x402":
    case "commit_spend":
      return checkSpendUse(name, args, context);
    case "request_buyer_confirmation":
      return facts.pendingId !== undefined && args.pendingId === facts.pendingId
        ? { ok: true }
        : refuse("UNKNOWN_RECEIVABLE", "the buyer only confirms the receivable upload_receivable created in this run");
    case "request_buyer_repayment":
      return facts.funded !== undefined && args.id === facts.receivableId
        ? { ok: true }
        : refuse("NOT_FINANCED_IN_RUN", "the buyer is only asked to repay the receivable this run financed");
    default:
      return { ok: true };
  }
}
