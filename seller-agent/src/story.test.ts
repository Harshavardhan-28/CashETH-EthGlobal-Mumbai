import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { runSellerAgent } from "./run.js";
import { BUYER, callTool, PAID_API, ScriptedChatModel } from "./test/fakes.js";
import { setupRun } from "./test/setup.js";

const DOC = "0x" + "d".repeat(64);
const PENDING = "0x" + "e".repeat(64);
const ID = "0x" + "1".repeat(64);
const SPEND = "0x" + "5".repeat(64);
const PAYEE_EVM = "0x0000000000000000000000000000000000acedb8";
const PAID_URL = `${PAID_API}/price-feed?symbols=HBAR`;
const SETTLEMENT = "0.0.9185802@1762500000.000000001";
const link = (what: string) => `https://hashscan.io/testnet/transaction/${what}`;

const requirements = { x402Version: 2, accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "500000", asset: "0.0.429274", payTo: "0.0.11333304" }] };
const paidApiFetch = (async () =>
  new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(requirements)).toString("base64") } })) as unknown as typeof fetch;

const answers = {
  upload_invoice_document: { keccak256: DOC, hashscan: "https://hashscan.io/testnet/topic/0.0.5/message/3" },
  upload_receivable: { pendingId: PENDING, id: ID, confirmationRequest: { typedData: { message: { amount: "2000000" } } } },
  get_quotes: { id: ID, plan: { total: "1500000", fills: [] } },
  open_facility: { id: ID, funded: "1500000", txHash: "0xf0", hashscan: link("0xf0") },
  set_budgets: { id: ID, mode: "sent", txHash: "0xb0", hashscan: link("0xb0") },
  reserve_spend: { id: ID, spendId: SPEND, amount: "500000", txHash: "0x50", hashscan: link("0x50") },
  pay_x402: { spendId: SPEND, transactionId: SETTLEMENT, hashscan: link(SETTLEMENT), status: 200, body: { prices: { HBAR: 0.31 } } },
  commit_spend: { spendId: SPEND, txHash: "0xc1", hashscan: link("0xc1"), payment: link(SETTLEMENT) },
  get_receivable_status: { id: ID, state: "Repaid" },
};

const script = () => [
  callTool("http_get", { url: PAID_URL }),
  callTool("upload_invoice_document", { receivableRef: "PO-1" }),
  callTool("upload_receivable", { buyer: BUYER, amount: "2000000", dueDate: 1_797_000_000, buyerRef: "PO-1", documentKeccak: DOC }),
  callTool("request_buyer_confirmation", { pendingId: PENDING }),
  callTool("get_quotes", { id: ID }),
  callTool("open_facility", { id: ID }),
  callTool("set_budgets", { id: ID, budgets: [{ worker: "0xd1", alloc: "1000000", maxPerTx: "500000", maxDaily: "1000000", merchants: [PAYEE_EVM] }] }),
  callTool("reserve_spend", { id: ID, merchant: PAYEE_EVM, amount: "500000" }),
  callTool("pay_x402", { spendId: SPEND, url: PAID_URL }),
  callTool("commit_spend", { spendId: SPEND, hederaTxId: SETTLEMENT }),
  callTool("request_buyer_repayment", { id: ID }),
  callTool("get_receivable_status", { id: ID }),
  new AIMessage("Bought the HBAR price with credit; the buyer repaid."),
];

describe("the seller agent story", () => {
  it("runs 402 -> credit -> purchase -> repayment and records the receivable, settlement and repayment in phase order", async () => {
    const { calls, buyerLog, options } = setupRun(new ScriptedChatModel(script()), { answers, fetch: paidApiFetch });

    const result = await runSellerAgent(options);

    expect(result.status).toBe("completed");
    expect(result.audit.map((a) => a.tool)).toEqual([
      "http_get", "upload_invoice_document", "upload_receivable", "request_buyer_confirmation", "get_quotes", "open_facility",
      "set_budgets", "reserve_spend", "pay_x402", "commit_spend", "request_buyer_repayment", "get_receivable_status",
    ]);
    expect(result.audit.every((a) => a.outcome === "ok")).toBe(true);
    expect(result.facts).toMatchObject({
      paywall: { payTo: "0.0.11333304", amount: "500000" },
      receivableId: ID,
      spendIds: [SPEND],
      spent: "500000",
      settlement: { spendId: SPEND, transactionId: SETTLEMENT },
      repayTx: "0xr0",
      repaid: true,
    });
    expect(buyerLog).toEqual([`confirm:${PENDING}`, `repay:${ID}:2000000`]);
    expect(calls.find((c) => c.tool === "upload_invoice_document")!.args).toMatchObject({ content: "JVBERi0xLjc=", mime: "application/pdf" });
  });

  it("collects every HashScan link the tools returned", async () => {
    const { options } = setupRun(new ScriptedChatModel(script()), { answers, fetch: paidApiFetch });

    const result = await runSellerAgent(options);

    const links = result.audit.flatMap((a) => a.links);
    expect(links).toEqual(expect.arrayContaining([link("0xf0"), link("0x50"), link(SETTLEMENT), link("0xc1"), link("0xc0"), link("0xr0")]));
  });

  it("only treats a successful status of Repaid as repayment, not the model's claim", async () => {
    const early = [callTool("get_receivable_status", { id: ID }), new AIMessage("The buyer repaid, all done!")];
    const { options } = setupRun(new ScriptedChatModel(early), { answers: { get_receivable_status: { id: ID, state: "Financed" } } });

    const result = await runSellerAgent(options);

    expect(result.status).toBe("incomplete");
    expect(result.facts.repaid).toBeUndefined();
  });
});
