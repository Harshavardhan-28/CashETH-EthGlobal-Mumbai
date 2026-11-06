/** What the run has established so far, read from tool results by code (never from what the model says). */
import type { Hex } from "viem";

export interface Facts {
  pendingId?: Hex;
  /** `upload_receivable`'s answer: the buyer signs its typed data, never the model. */
  upload?: Record<string, unknown>;
  /** The receivable's face amount (units): what the buyer repays. */
  amount?: string;
  receivableId?: Hex;
  /** The facility's funded amount (units) once `open_facility` succeeded. */
  funded?: string;
  /** Reservations made in this run: the only ones `pay_x402` and `commit_spend` may use. */
  spendIds: string[];
  /** USDC units reserved in this run (a decimal string, so the state stays JSON). */
  spent: string;
  /** `get_receivable_status` showed the receivable as Repaid. */
  repaid?: boolean;
}

export const emptyFacts = (): Facts => ({ spendIds: [], spent: "0" });

/** What a tool result establishes. Only successful results count; the model's own claims never do. */
export function applyResult(_facts: Facts, _call: { name: string; args: Record<string, unknown> }, _result: unknown): Partial<Facts> {
  return {};
}
