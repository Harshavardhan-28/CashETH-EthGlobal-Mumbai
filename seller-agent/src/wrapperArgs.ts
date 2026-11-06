/** What the wrapper adds to an approved call: the idempotency key, the pinned account arguments and stored facts. */
import { longZeroEvmAddress } from "@casheth/hedera";
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

const HEDERA_ACCOUNT = /^\d+\.\d+\.\d+$/;
/** The model names merchants by Hedera account id; the tools take the long-zero EVM address. */
const toEvm = (merchant: unknown): unknown => (typeof merchant === "string" && HEDERA_ACCOUNT.test(merchant) ? longZeroEvmAddress(merchant) : merchant);

function normaliseMerchants(name: string, args: Record<string, unknown>): void {
  if (name === "reserve_spend") args.merchant = toEvm(args.merchant);
  if (name === "set_budgets" && Array.isArray(args.budgets)) {
    args.budgets = args.budgets.map((budget: Record<string, unknown>) =>
      Array.isArray(budget?.merchants) ? { ...budget, merchants: budget.merchants.map(toEvm) } : budget,
    );
  }
}

export function wrapperArgs(name: string, modelArgs: Record<string, unknown>, { runId, step, index, facts, pinned }: WrapperContext): Record<string, unknown> {
  const { idempotencyKey: _ignored, ...args } = modelArgs;
  normaliseMerchants(name, args);
  Object.assign(args, pinned[name] ?? {});
  if (name === "request_buyer_confirmation") args.upload = facts.upload;
  if (name === "request_buyer_repayment") args.amount = facts.amount;
  if (MUTATING.has(name)) args.idempotencyKey = stepKey(runId, step, index, name);
  return args;
}
