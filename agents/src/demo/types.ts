import type { Address } from "viem";
import type { AgentKit } from "../kit.js";
import type { BuyerAgent } from "../buyer.js";
import type { LenderAgent } from "../lender.js";
import type { Log } from "../log.js";
import type { Invoice, SellerAgent, UploadResult } from "../seller.js";
import type { WorkerAgent } from "../worker.js";
import type { PollOptions } from "./poll.js";
import type { ReadApi } from "./readApi.js";

/** What one demo step proved. `txId` is a Hedera transaction id; `link` its HashScan page. */
export interface StepResult {
  label: string;
  txId?: string;
  link?: string;
  note?: string;
  /** Preformatted text (a table) printed under the evidence table. */
  detail?: string;
  /** The step did not run (nothing to do, or not available in this build); it needs no transaction. */
  skipped?: boolean;
  /** The step only reads and prints; it needs no transaction. */
  readOnly?: boolean;
  /** The step threw: the run stops here. */
  error?: string;
}

export type StepOutcome = Omit<StepResult, "label" | "error">;

export interface Step {
  label: string;
  run(ctx: DemoContext): Promise<StepOutcome>;
}

export type LenderKey = "A" | "B" | "C" | "D";

/** The two lenders that ship fresh strategies in step 1. */
export interface ShippingLender {
  address: Address;
  accountId: string;
  agent: LenderAgent;
}

export interface DemoWorker {
  address: Address;
  /** Long-zero EVM address of the worker's 2-of-2 spend wallet. */
  spendWallet: Address;
  agent: WorkerAgent;
  kit: AgentKit;
}

/** Everything the steps need, wired to the real agents by `buildContext` and to fakes in the unit tests. */
export interface DemoContext {
  log: Log;
  invoice: Invoice;
  seller: { address: Address; accountId: string; agent: SellerAgent; kit: AgentKit };
  buyer: { address: Address; agent: BuyerAgent };
  research: DemoWorker;
  compute: DemoWorker;
  lenders: { A: ShippingLender; B: ShippingLender };
  /** The EVM address of each of the four lenders, to read the solver's plan by maker. */
  makers: Record<LenderKey, Address>;
  /** The x402 merchant's EVM (long-zero) address: the one merchant on every worker's allowlist. */
  merchant: Address;
  read: ReadApi;
  usdcBalance(address: Address): Promise<bigint>;
  /** Moves `units` USDC from the operator to `accountId`; resolves with the Hedera transaction id. */
  topUpFromOperator(accountId: string, units: bigint): Promise<string>;
  /** The Hedera transaction id for an EVM transaction hash (or an id, returned unchanged). */
  resolveTx(ref: string): Promise<string>;
  poll: PollOptions;
  /** What earlier steps produced for later ones. */
  state: { upload?: UploadResult };
}
