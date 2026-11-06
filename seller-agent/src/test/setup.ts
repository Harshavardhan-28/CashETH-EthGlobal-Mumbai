/** Builds `runSellerAgent` options from fakes. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SellerAgentOptions } from "../run.js";
import { BUYER, fakeBuyer, fakeSession, memoryTranscript, PAID_API, SELLER, SPEND_WALLET, WORKER, type RecordedCall } from "./fakes.js";

export function setupRun(model: BaseChatModel, { answers = {}, fetch, maxSteps }: { answers?: Record<string, unknown>; fetch?: typeof globalThis.fetch; maxSteps?: number } = {}) {
  const calls: RecordedCall[] = [];
  const transcript = memoryTranscript();
  const buyerLog: string[] = [];
  const options: SellerAgentOptions = {
    model,
    seller: fakeSession("seller", calls, answers),
    worker: fakeSession("worker", calls, answers),
    buyer: fakeBuyer(buyerLog),
    ...(fetch ? { fetch } : {}),
    account: { seller: SELLER, worker: { ...WORKER, spendWallet: SPEND_WALLET } },
    invoice: { filename: "invoice-PO-1.pdf", mime: "application/pdf", content: "JVBERi0xLjc=", buyer: BUYER, amount: "2000000", dueDate: 1_797_000_000, buyerRef: "PO-1" },
    paidApiUrl: `${PAID_API}/price-feed?symbols=HBAR`,
    runId: "run-test",
    ...(maxSteps ? { maxSteps } : {}),
    transcript,
  };
  return { calls, transcript, buyerLog, options };
}

export const nodesVisited = (entries: Record<string, unknown>[]) => entries.filter((e) => e.type === "node").map((e) => e.node);
