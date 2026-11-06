/** What the run has established so far, read from tool results by code (never from what the model says). */
import type { Hex } from "viem";

export interface Facts {
  pendingId?: Hex;
  receivableId?: Hex;
  /** The facility's funded amount (units) once `open_facility` succeeded. */
  funded?: string;
  /** Reservations made in this run: the only ones `pay_x402` and `commit_spend` may use. */
  spendIds: string[];
  /** USDC units reserved in this run (a decimal string, so the state stays JSON). */
  spent: string;
}

export const emptyFacts = (): Facts => ({ spendIds: [], spent: "0" });
