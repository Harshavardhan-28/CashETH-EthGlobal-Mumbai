/**
 * LLM-driven agent: a model decides which MCP tools to call, this wrapper decides whether the call goes out.
 * The model never sees keys, never writes idempotency keys and cannot call a side-effecting tool the operator did not
 * allow. Spend is capped client-side before `reserve_spend` is forwarded, and the model can only pay or commit
 * reservations it made in this run. The control plane's own checks (token scopes, budgets, co-signer) still apply.
 */
import { randomUUID } from "node:crypto";
import { consoleLog, type Log } from "../log.js";
import { idempotencyKey, ToolCallError, type ToolCaller } from "../mcpClient.js";
import type { AuditSink, ToolOutcome } from "./audit.js";
import { buildSystemPrompt, type LlmRole } from "./prompts.js";
import { propertiesOf, READ_ONLY_TOOLS, toolDefFor, WRAPPER_ARGS, type LocalTool, type McpToolDefinition } from "./tools.js";
import type { ChatMessage, ChatModel, ToolCall, ToolDef } from "./types.js";

/** What the agent needs from the MCP side: `AgentClient` implements it, tests substitute a fake. */
export interface LlmToolClient extends ToolCaller {
  listToolDefinitions(): Promise<McpToolDefinition[]>;
}

export interface LlmAgentOptions {
  client: LlmToolClient;
  model: ChatModel;
  role: LlmRole;
  /** Side-effecting tools the model may use. Read-only tools are always available; the default allows no other. */
  allowTools?: readonly string[];
  /** Per-run cap on the USDC base units reserved through `reserve_spend`; required when that tool is allowed. */
  maxSpend?: bigint;
  /** Model turns before the run stops (default 12). */
  maxSteps?: number;
  /** Names the run: idempotency keys derive from it, so a repeat of the same run replays instead of paying twice. */
  runId?: string;
  /** Arguments fixed on every tool whose schema has them (receivable id, worker, spend wallet); hidden from the model. */
  pinned?: Record<string, unknown>;
  localTools?: LocalTool[];
  audit?: AuditSink;
  log?: Log;
}

export type RunStatus = "completed" | "max_steps" | "refused" | "truncated";

export interface ToolCallRecord {
  step: number;
  tool: string;
  input: Record<string, unknown>;
  outcome: ToolOutcome;
  result: unknown;
}

export interface LlmRunResult {
  runId: string;
  status: RunStatus;
  /** The model's final text. */
  answer: string;
  steps: number;
  /** USDC base units reserved in this run. */
  spent: bigint;
  toolCalls: ToolCallRecord[];
}

type Outcome = { outcome: ToolOutcome; result: unknown };

const DEFAULT_MAX_STEPS = 12;
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): Outcome => ({ outcome: "refused", result: { code, message, ...extra } });

/** JSON with sorted keys, so equal arguments always derive the same idempotency key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class LlmAgent {
  readonly runId: string;
  readonly #o: LlmAgentOptions;
  readonly #allow: ReadonlySet<string>;
  readonly #maxSteps: number;
  readonly #pinned: Record<string, unknown>;
  readonly #log: Log;
  readonly #reserved = new Set<string>();
  #spent = 0n;

  constructor(options: LlmAgentOptions) {
    this.#o = options;
    this.#allow = new Set(options.allowTools ?? []);
    if (this.#allow.has("reserve_spend") && options.maxSpend === undefined) {
      throw new Error("reserve_spend is allowed but no maxSpend cap is set: a spending run needs a cap");
    }
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#pinned = options.pinned ?? {};
    this.#log = options.log ?? consoleLog;
    this.runId = options.runId ?? randomUUID();
  }

  /** Runs the loop: the model calls tools until it answers, is refused, or hits `maxSteps`. */
  async run(goal: string): Promise<LlmRunResult> {
    const mcpTools = (await this.#o.client.listToolDefinitions()).filter((t) => this.#isOffered(t.name));
    const hidden = new Set<string>([...WRAPPER_ARGS, ...Object.keys(this.#pinned)]);
    const tools: ToolDef[] = [...mcpTools.map((t) => toolDefFor(t, hidden)), ...(this.#o.localTools ?? []).map((t) => t.def)];
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(this.#o.role, { maxSpend: this.#o.maxSpend, pinned: this.#pinned }) },
      { role: "user", content: goal },
    ];
    const toolCalls: ToolCallRecord[] = [];
    this.#log("llm run started", { runId: this.runId, role: this.#o.role, provider: this.#o.model.provider, model: this.#o.model.model, tools: tools.map((t) => t.name) });

    let status: RunStatus = "max_steps";
    let answer = "";
    let steps = 0;
    while (steps < this.#maxSteps) {
      steps += 1;
      const reply = await this.#o.model.chat(messages, tools);
      messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
      if (reply.finish !== "tool_calls" || reply.toolCalls.length === 0) {
        answer = reply.text;
        status = reply.finish === "refusal" ? "refused" : reply.finish === "length" ? "truncated" : "completed";
        break;
      }
      // Sequential on purpose: the spend cap and the reserve -> pay -> commit order depend on earlier results.
      for (const call of reply.toolCalls) {
        const { outcome, result } = await this.#execute(call, mcpTools, steps);
        toolCalls.push({ step: steps, tool: call.name, input: call.input, outcome, result });
        this.#o.audit?.record({ kind: "tool_call", runId: this.runId, step: steps, tool: call.name, input: call.input, outcome, result });
        this.#log("llm tool call", { step: steps, tool: call.name, outcome });
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result), isError: outcome !== "ok" });
      }
    }

    this.#o.audit?.record({ kind: "run_finished", runId: this.runId, status, steps, spent: this.#spent.toString(), answer });
    this.#log("llm run finished", { runId: this.runId, status, steps, spent: this.#spent });
    return { runId: this.runId, status, answer, steps, spent: this.#spent, toolCalls };
  }

  #isOffered(tool: string): boolean {
    return READ_ONLY_TOOLS.has(tool) || this.#allow.has(tool);
  }

  async #execute(call: ToolCall, mcpTools: McpToolDefinition[], step: number): Promise<Outcome> {
    const local = this.#o.localTools?.find((t) => t.def.name === call.name);
    const definition = mcpTools.find((t) => t.name === call.name);
    if (!local && !definition) {
      const available = [...mcpTools.map((t) => t.name), ...(this.#o.localTools ?? []).map((t) => t.def.name)];
      return refusal("TOOL_NOT_ALLOWED", `"${call.name}" is not an available tool`, { available });
    }
    if (call.argumentsError) return refusal("BAD_INPUT", `${call.name}: ${call.argumentsError}`);
    try {
      if (local) return { outcome: "ok", result: await local.run(call.input) };
      return await this.#callMcp(call, definition!, step);
    } catch (error) {
      if (error instanceof ToolCallError) return { outcome: "error", result: error.details };
      return { outcome: "error", result: { code: "CLIENT_ERROR", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async #callMcp(call: ToolCall, definition: McpToolDefinition, step: number): Promise<Outcome> {
    const properties = propertiesOf(definition.inputSchema);
    const args: Record<string, unknown> = { ...call.input };
    for (const name of WRAPPER_ARGS) delete args[name];
    for (const [name, value] of Object.entries(this.#pinned)) if (name in properties) args[name] = value;

    const blocked = this.#guard(call.name, args);
    if (blocked) return blocked;
    if ("idempotencyKey" in properties) args.idempotencyKey = idempotencyKey(`llm-${call.name}`, this.runId, stableStringify(args));

    const result = await this.#o.client.call(call.name, args);
    if (call.name === "reserve_spend") this.#recordReservation(args, result);
    this.#log("llm tool forwarded", { step, tool: call.name });
    return { outcome: "ok", result };
  }

  /** Client-side limits that hold whatever the model says. Returns a refusal, or `undefined` to forward the call. */
  #guard(tool: string, args: Record<string, unknown>): Outcome | undefined {
    if (tool === "reserve_spend") {
      const requested = typeof args.amount === "string" && /^\d+$/.test(args.amount) ? BigInt(args.amount) : 0n;
      if (requested === 0n) return refusal("BAD_INPUT", "reserve_spend needs a positive amount as a decimal string of base units", { field: "amount" });
      const cap = this.#o.maxSpend ?? 0n;
      if (this.#spent + requested > cap) {
        return refusal("SPEND_CAP_EXCEEDED", "this run's spend cap would be exceeded; nothing was reserved", {
          cap: cap.toString(),
          spent: this.#spent.toString(),
          requested: requested.toString(),
        });
      }
    }
    if ((tool === "pay_x402" || tool === "commit_spend") && !this.#reserved.has(String(args.spendId))) {
      return refusal("UNKNOWN_SPEND", `${tool} only accepts a spendId reserved earlier in this run`, { field: "spendId" });
    }
    return undefined;
  }

  #recordReservation(args: Record<string, unknown>, result: unknown): void {
    this.#spent += BigInt(args.amount as string);
    const spendId = (result as { spendId?: unknown }).spendId;
    if (typeof spendId === "string") this.#reserved.add(spendId);
  }
}
