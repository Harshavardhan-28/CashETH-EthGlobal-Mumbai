import { describe, expect, it } from "vitest";
import { emptyFacts, type Facts } from "./facts.js";
import { nextStepHint, type HintContext } from "./hint.js";

const ID = "0x" + "1".repeat(64);
const PENDING = "0x" + "e".repeat(64);
const DOC = "0x" + "d".repeat(64);
const SPEND = "0x" + "5".repeat(64);
const PAID_URL = "https://paid.example/price-feed?symbols=HBAR";
const PAYEE_EVM = "0x0000000000000000000000000000000000aceeb8"; // 0.0.11333304 in long-zero form
const WORKER = "0x00000000000000000000000000000000000000d1";

const context: HintContext = {
  account: { seller: { address: "0xa1", accountId: "0.0.1" }, worker: { address: WORKER, accountId: "0.0.2", spendWallet: "0xf1" } },
  invoice: { buyer: "0xb1", amount: "2000000", dueDate: 1_797_000_000, buyerRef: "PO-77" },
  paidApiUrl: PAID_URL,
};

const paywall = { url: PAID_URL, payTo: "0.0.11333304", amount: "500000" };
const at = (facts: Partial<Facts>): Facts => ({ ...emptyFacts(), ...facts });
const raised = { paywall, documentKeccak: DOC as `0x${string}`, pendingId: PENDING as `0x${string}`, receivableId: ID as `0x${string}` };

describe("nextStepHint", () => {
  it.each([
    ["nothing yet", at({}), ["http_get", PAID_URL]],
    ["the 402 seen", at({ paywall }), ["upload_invoice_document", "PO-77"]],
    ["the invoice stored", at({ paywall, documentKeccak: DOC as `0x${string}` }), ["upload_receivable", DOC, "2000000", "PO-77"]],
    ["the receivable uploaded", at(raised), ["request_buyer_confirmation", PENDING]],
    ["the buyer confirmed", at({ ...raised, confirmed: "x" }), ["get_quotes", ID]],
    ["quotes read", at({ ...raised, confirmed: "x", quoted: true }), ["open_facility", ID]],
    ["the facility funded", at({ ...raised, confirmed: "x", quoted: true, funded: "1500000" }), ["set_budgets", WORKER, PAYEE_EVM, "500000"]],
    ["budgets set", at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true }), ["reserve_spend", PAYEE_EVM, "500000"]],
    ["reserved", at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true, spendIds: [SPEND] }), ["pay_x402", SPEND, PAID_URL]],
    [
      "paid",
      at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true, spendIds: [SPEND], settlement: { spendId: SPEND, transactionId: "0.0.9@1.2" } }),
      ["commit_spend", SPEND, "0.0.9@1.2"],
    ],
    [
      "committed",
      at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true, spendIds: [SPEND], settlement: { spendId: SPEND, transactionId: "t" }, committed: true }),
      ["request_buyer_repayment", ID],
    ],
    [
      "repayment sent",
      at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true, spendIds: [SPEND], settlement: { spendId: SPEND, transactionId: "t" }, committed: true, repayTx: "0xr" }),
      ["get_receivable_status", ID],
    ],
  ])("after %s, names the next tool and the exact values to use", (_label, facts, expected) => {
    const hint = nextStepHint(facts, context);
    for (const piece of expected) expect(hint).toContain(piece);
  });

  it("once repaid, tells the model to stop calling tools and summarise", () => {
    const facts = at({ ...raised, confirmed: "x", quoted: true, funded: "1", budgetsSet: true, spendIds: [SPEND], settlement: { spendId: SPEND, transactionId: "t" }, committed: true, repayTx: "0xr", repaid: true });
    expect(nextStepHint(facts, context)).toMatch(/no more tool calls/i);
  });
});
