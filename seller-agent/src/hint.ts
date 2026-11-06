/**
 * The deterministic next step the plan node shows the model, derived from the facts the run has established. A small
 * local model loses track of a twelve-call plan; the graph does not. The model still chooses and makes every call.
 */
import { longZeroEvmAddress } from "@casheth/hedera";
import type { Facts } from "./facts.js";
import type { PromptContext } from "./prompt.js";

export type HintContext = Pick<PromptContext, "account" | "invoice" | "paidApiUrl">;

const json = (value: unknown) => JSON.stringify(value);

export function nextStepHint(facts: Facts, { account, invoice, paidApiUrl }: HintContext): string {
  const id = facts.receivableId;
  const merchant = facts.paywall ? longZeroEvmAddress(facts.paywall.payTo) : undefined;
  const price = facts.paywall?.amount;
  const spendId = facts.spendIds.at(-1);

  if (!facts.paywall) return `phase 1: call http_get with ${json({ url: paidApiUrl })} to see what the data costs.`;
  if (!facts.documentKeccak) return `phase 2: the API wants ${price} units you do not have. Call upload_invoice_document with ${json({ receivableRef: invoice.buyerRef })}.`;
  if (!facts.pendingId || !id) {
    const { buyer, amount, dueDate, buyerRef } = invoice;
    return `phase 2: call upload_receivable with ${json({ buyer, amount, dueDate, buyerRef, documentKeccak: facts.documentKeccak })}.`;
  }
  if (!facts.confirmed) return `phase 2: call request_buyer_confirmation with ${json({ pendingId: facts.pendingId })}.`;
  if (!facts.quoted) return `phase 2: call get_quotes with ${json({ id })}.`;
  if (!facts.funded) return `phase 2: call open_facility with ${json({ id })}.`;
  if (!facts.budgetsSet) {
    const budget = { worker: account.worker.address, alloc: price, maxPerTx: price, maxDaily: price, merchants: [merchant] };
    return `phase 2: call set_budgets with ${json({ id, budgets: [budget] })}.`;
  }
  if (!spendId) return `phase 3: call reserve_spend with ${json({ id, merchant, amount: price })}.`;
  if (!facts.settlement) return `phase 3: call pay_x402 with ${json({ spendId, url: facts.paywall.url })}.`;
  if (!facts.committed) return `phase 3: call commit_spend with ${json({ spendId: facts.settlement.spendId, hederaTxId: facts.settlement.transactionId })}.`;
  if (!facts.repayTx) return `phase 4: you have the data. Call request_buyer_repayment with ${json({ id })}.`;
  if (!facts.repaid) return `phase 4: call get_receivable_status with ${json({ id })} to see the repayment land.`;
  return "done: every phase is complete. Make no more tool calls; write the final summary with every HashScan link.";
}
