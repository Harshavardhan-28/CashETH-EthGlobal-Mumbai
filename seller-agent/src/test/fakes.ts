/** Fakes for the seller-agent tests: MCP sessions, buyer, chat model. No network, no Ollama, no testnet. */
import { ToolCallError, type LlmToolClient, type McpToolDefinition } from "@casheth/agents";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

const schema = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", properties, required });
const str = { type: "string" };

/** A `tools/list` shaped like the CashETH MCP server's (docs/API.md section 3), trimmed to the fields the agent uses. */
export const TOOL_LIST: McpToolDefinition[] = [
  { name: "upload_invoice_document", description: "Store the invoice file", inputSchema: schema({ receivableRef: str, filename: str, mime: str, content: str, idempotencyKey: str }) },
  { name: "upload_receivable", description: "Upload a receivable", inputSchema: schema({ seller: str, buyer: str, amount: str, dueDate: { type: "number" }, buyerRef: str, documentKeccak: str, idempotencyKey: str }, ["buyer", "amount", "dueDate", "buyerRef", "idempotencyKey"]) },
  { name: "confirm_receivable", description: "Buyer confirms", inputSchema: schema({ pendingId: str, signature: str, idempotencyKey: str }) },
  { name: "get_receivable_status", description: "Status", inputSchema: schema({ id: str }) },
  { name: "get_quotes", description: "Quotes", inputSchema: schema({ id: str }) },
  { name: "open_facility", description: "Open", inputSchema: schema({ id: str, idempotencyKey: str }) },
  { name: "set_budgets", description: "Budgets", inputSchema: schema({ id: str, budgets: { type: "array" }, idempotencyKey: str }) },
  { name: "reserve_spend", description: "Reserve", inputSchema: schema({ id: str, worker: str, spendWallet: str, merchant: str, amount: str, ttlSeconds: { type: "number" }, idempotencyKey: str }, ["id", "worker", "spendWallet", "merchant", "amount", "idempotencyKey"]) },
  { name: "pay_x402", description: "Pay", inputSchema: schema({ spendId: str, url: str, idempotencyKey: str }) },
  { name: "commit_spend", description: "Commit", inputSchema: schema({ spendId: str, hederaTxId: str, idempotencyKey: str }) },
  { name: "release_spend", description: "Release", inputSchema: schema({ spendId: str, idempotencyKey: str }) },
  { name: "repay_receivable", description: "Repay", inputSchema: schema({ id: str, amount: str, idempotencyKey: str }) },
  { name: "register_agent", description: "Admin", inputSchema: schema({ account: str, idempotencyKey: str }) },
];

export interface RecordedCall {
  session: string;
  tool: string;
  args: Record<string, unknown>;
}

/** An MCP session: answers each tool from `answers` (a value, or a function of the args); an Error answer is thrown. */
export function fakeSession(session: string, calls: RecordedCall[], answers: Record<string, unknown> = {}): LlmToolClient {
  return {
    listToolDefinitions: async () => TOOL_LIST,
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ session, tool, args });
      const answer = answers[tool];
      const value = typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
      if (value instanceof ToolCallError) throw value;
      return (value ?? { ok: true }) as T;
    },
  };
}

/** A chat model that replays scripted replies (each a function of the messages it was given, or a fixed message). */
export class ScriptedChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  boundTools: unknown[] = [];
  readonly #script: (AIMessage | ((messages: BaseMessage[]) => AIMessage))[];

  constructor(script: (AIMessage | ((messages: BaseMessage[]) => AIMessage))[]) {
    super({});
    this.#script = [...script];
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(tools: unknown[]) {
    this.boundTools = tools;
    return this as never;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const next = this.#script.shift() ?? new AIMessage("done");
    const message = typeof next === "function" ? next(messages) : next;
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] };
  }
}

let callSeq = 0;
/** An assistant turn that calls `name` with `args`. */
export const callTool = (name: string, args: Record<string, unknown>): AIMessage =>
  new AIMessage({ content: "", tool_calls: [{ id: `call_${++callSeq}`, name, args, type: "tool_call" }] });

export const PAID_API = "https://paid.example";
export const SELLER = { address: "0x00000000000000000000000000000000000000a1", accountId: "0.0.1001", key: "0x" + "ab".repeat(32), uaid: "uaid:seller" } as const;
export const WORKER = { address: "0x00000000000000000000000000000000000000d1", accountId: "0.0.1002", key: "0x" + "cd".repeat(32), uaid: "uaid:worker" } as const;
export const SPEND_WALLET = "0x00000000000000000000000000000000000f4242";
export const BUYER = "0x00000000000000000000000000000000000000b1";

/** An in-memory transcript. */
export function memoryTranscript() {
  const entries: Record<string, unknown>[] = [];
  return { entries, write: (entry: Record<string, unknown>) => void entries.push(entry) };
}

/** A buyer that records what it was asked. */
export function fakeBuyer(log: string[] = []) {
  return {
    log,
    async confirm(upload: { pendingId: string; id: string }) {
      log.push(`confirm:${upload.pendingId}`);
      return { id: upload.id, txHash: "0xc0", hashscan: "https://hashscan.io/testnet/transaction/0xc0", nftSerial: 7, hcsSeq: 9, decision: { approved: true, score: 80, advanceBps: 7500, limit: "1500000", reasons: [] } };
    },
    async repay(id: string, amount: bigint) {
      log.push(`repay:${id}:${amount}`);
      return { id, mode: "sent" as const, approveTxHash: "0xa0", txHash: "0xr0", hashscan: "https://hashscan.io/testnet/transaction/0xr0", state: "Repaid" };
    },
  };
}
