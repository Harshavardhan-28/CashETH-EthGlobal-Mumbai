/** What the wrapper adds to an approved call: the idempotency key, the pinned account arguments and stored facts. */
import type { Facts } from "./facts.js";
import { stepKey } from "./keys.js";

/** CashETH tools that take an `idempotencyKey` (every mutating one the agent uses). */
const MUTATING = new Set(["upload_invoice_document", "upload_receivable", "open_facility", "set_budgets", "reserve_spend", "pay_x402", "commit_spend"]);

export interface WrapperContext {
  runId: string;
  step: number;
  index: number;
  facts: Facts;
  /** Per tool, arguments fixed by the operator (accounts, the invoice file); they override the model. */
  pinned: Record<string, Record<string, unknown>>;
}

export function wrapperArgs(name: string, modelArgs: Record<string, unknown>, { runId, step, index, facts, pinned }: WrapperContext): Record<string, unknown> {
  const { idempotencyKey: _ignored, ...args } = modelArgs;
  Object.assign(args, pinned[name] ?? {});
  if (name === "request_buyer_confirmation") args.upload = facts.upload;
  if (name === "request_buyer_repayment") args.amount = facts.amount;
  if (MUTATING.has(name)) args.idempotencyKey = stepKey(runId, step, index, name);
  return args;
}
