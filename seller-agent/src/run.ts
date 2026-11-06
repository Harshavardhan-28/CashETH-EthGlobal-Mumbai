/** Runs one demonstration: builds the tool set and the graph, streams node transitions live, writes the transcript. */
import type { LlmToolClient, UploadResult } from "@casheth/agents";
import type { Hex } from "viem";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Facts } from "./facts.js";
import { buildSellerGraph } from "./graph.js";
import { createHttpGet } from "./httpGet.js";
import { nextStepHint } from "./hint.js";
import { buildSystemPrompt, type PublicAccount, type RunInvoice } from "./prompt.js";
import type { AuditEntry, RunStatus, SellerStateType } from "./state.js";
import { buildToolset } from "./toolset.js";

export interface TranscriptSink {
  write(entry: Record<string, unknown>): void;
}

/** The buyer side: `createBuyerAgent` from `@casheth/agents` (it signs the confirmation and repays with its own key). */
export interface CounterpartyBuyer {
  confirm(upload: UploadResult): Promise<unknown>;
  repay(id: Hex, amount: bigint): Promise<unknown>;
}

export interface SellerAgentOptions {
  model: BaseChatModel;
  /** MCP session authenticated as the seller account. */
  seller: LlmToolClient;
  /** MCP session authenticated as the seller's research worker. */
  worker: LlmToolClient;
  /** The buyer is another party: the scripted buyer agent signs and repays with its own key. */
  buyer: CounterpartyBuyer;
  account: { seller: PublicAccount; worker: PublicAccount & { spendWallet: string } };
  invoice: RunInvoice & { filename: string; mime: string; content: string };
  /** The paid resource the agent wants, e.g. `<paid API>/price-feed?symbols=HBAR`. */
  paidApiUrl: string;
  /** Other origins `http_get` may read (the local merchant). */
  extraHttpOrigins?: string[];
  runId?: string;
  maxSteps?: number;
  /** USDC units this run may reserve in total (default 1 USDC). */
  spendCap?: bigint;
  fetch?: typeof fetch;
  transcript?: TranscriptSink;
  /** Called with each node's update as it happens (the CLI prints it). */
  onNode?(node: string, update: Record<string, unknown>): void;
}

export interface SellerAgentResult {
  runId: string;
  status: RunStatus;
  error?: string;
  answer: string;
  facts: Facts;
  audit: AuditEntry[];
}

export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_SPEND_CAP = 1_000_000n;

export async function runSellerAgent(options: SellerAgentOptions): Promise<SellerAgentResult> {
  const { account, invoice, paidApiUrl, transcript, onNode } = options;
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const spendCap = options.spendCap ?? DEFAULT_SPEND_CAP;
  const paidApiOrigin = new URL(paidApiUrl).origin;

  const httpGet = createHttpGet({ allowedOrigins: [paidApiOrigin, ...(options.extraHttpOrigins ?? [])], ...(options.fetch ? { fetch: options.fetch } : {}) });
  const toolset = await buildToolset({
    seller: options.seller,
    worker: options.worker,
    local: {
      httpGet: (args) => httpGet({ url: String(args.url) }),
      confirm: (args) => options.buyer.confirm(args.upload as UploadResult),
      repay: (args) => options.buyer.repay(args.id as Hex, BigInt(String(args.amount))),
    },
  });
  const { content, filename, mime, ...terms } = invoice;
  const graph = buildSellerGraph(options.model, toolset, {
    runId,
    maxSteps,
    spendCap,
    paidApiOrigin,
    systemPrompt: buildSystemPrompt({ account, invoice: terms, paidApiUrl, spendCap }),
    pinned: {
      upload_invoice_document: { content, filename, mime },
      upload_receivable: { seller: account.seller.address },
      reserve_spend: { worker: account.worker.address, spendWallet: account.worker.spendWallet },
    },
    hint: (facts) => nextStepHint(facts, { account, invoice: terms, paidApiUrl }),
  });

  const record = (entry: Record<string, unknown>) => transcript?.write({ runId, ts: new Date().toISOString(), ...entry });
  record({ type: "run_started", maxSteps, spendCap: spendCap.toString(), paidApiUrl, model: options.model._llmType() });

  let final: SellerStateType | undefined;
  const stream = await graph.stream({}, { streamMode: ["updates", "values"], recursionLimit: maxSteps * 3 + 10 });
  for await (const [mode, chunk] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
    if (mode === "values") {
      final = chunk as SellerStateType;
      continue;
    }
    for (const [node, update] of Object.entries(chunk)) {
      const summary = summarise(update);
      onNode?.(node, summary);
      record({ type: "node", node, update: summary });
    }
  }
  if (!final) throw new Error("the graph produced no state");
  const result: SellerAgentResult = {
    runId,
    status: final.status,
    ...(final.error ? { error: final.error } : {}),
    answer: final.answer,
    facts: final.facts,
    audit: final.audit,
  };
  record({ type: "run_finished", status: result.status, error: result.error, facts: result.facts });
  return result;
}

/** What a node changed, as plain JSON for the log and the transcript. */
function summarise(update: unknown): Record<string, unknown> {
  if (typeof update !== "object" || update === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (key === "messages" && Array.isArray(value)) {
      out.messages = value.map((m: { getType?: () => string; content?: unknown; tool_calls?: unknown }) => ({
        type: m.getType?.(),
        content: m.content,
        ...(m.tool_calls && (m.tool_calls as unknown[]).length > 0 ? { tool_calls: m.tool_calls } : {}),
      }));
    } else if (key === "approved" && Array.isArray(value)) {
      out.approved = value.map((c: { name: string }) => c.name);
    } else out[key] = value;
  }
  return out;
}
