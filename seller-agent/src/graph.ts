/**
 * The LangGraph state machine:
 *
 *   START -> plan -> (tool calls?) -> guard -> (anything approved?) -> tools -> plan ... -> report -> END
 *
 * `plan` is the LLM with the tools bound, `guard` the deterministic checks (and the wrapper's arguments), `tools` a
 * LangGraph ToolNode run one approved call at a time (reserve -> pay -> commit depend on each other), and `report`
 * the summary. Refused calls are answered in `guard` and never reach `tools`.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { applyResult, type Facts } from "./facts.js";
import { guardCall } from "./guard.js";
import { SellerState, type ApprovedCall, type AuditEntry, type SellerStateType } from "./state.js";
import type { Toolset } from "./toolset.js";
import { wrapperArgs } from "./wrapperArgs.js";

export interface GraphConfig {
  runId: string;
  maxSteps: number;
  spendCap: bigint;
  paidApiOrigin: string;
  systemPrompt: string;
  pinned: Record<string, Record<string, unknown>>;
  /** The deterministic next-step hint the plan node shows the model, from what the run has established. */
  hint(facts: Facts): string;
}

const lastAi = (messages: BaseMessage[]): AIMessage | undefined => {
  const last = messages.at(-1);
  return last instanceof AIMessage ? last : undefined;
};

const textOf = (message: BaseMessage | undefined): string => (typeof message?.content === "string" ? message.content : "");

const parse = (content: unknown): unknown => {
  try {
    return JSON.parse(String(content));
  } catch {
    return content;
  }
};

/** Every HashScan link anywhere in a tool result. */
function hashscanLinks(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string" && value.startsWith("https://hashscan.io/")) found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => hashscanLinks(v, found));
  else if (typeof value === "object" && value !== null) Object.values(value).forEach((v) => hashscanLinks(v, found));
  return [...new Set(found)];
}

/** The audit keeps arguments readable: the base64 invoice and the stored upload are summarised. */
function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.content === "string") out.content = `<${out.content.length} base64 chars>`;
  if (out.upload !== undefined) out.upload = "<stored upload_receivable answer>";
  return out;
}

export function buildSellerGraph(model: BaseChatModel, toolset: Toolset, config: GraphConfig) {
  if (!model.bindTools) throw new Error("the chat model does not support tool calling");
  const planner = model.bindTools(toolset.specs);
  const toolNode = new ToolNode(toolset.tools);

  const plan = async (state: SellerStateType) => {
    if (state.steps >= config.maxSteps) {
      return { status: "max_steps" as const, error: `stopped after maxSteps (${config.maxSteps}) model turns without finishing` };
    }
    const prompt = [new SystemMessage(config.systemPrompt), ...state.messages, new HumanMessage(`[controller] Next step: ${config.hint(state.facts)}`)];
    const reply = await planner.invoke(prompt);
    return { messages: [reply], steps: state.steps + 1 };
  };

  const guard = (state: SellerStateType) => {
    const calls = lastAi(state.messages)?.tool_calls ?? [];
    const approved: ApprovedCall[] = [];
    const refusals: ToolMessage[] = [];
    const audit: AuditEntry[] = [];
    let pendingSpend = 0n;
    calls.forEach((call, index) => {
      const id = call.id ?? `${state.steps}-${index}`;
      const verdict = guardCall({ name: call.name, args: call.args }, { facts: state.facts, spendCap: config.spendCap, paidApiOrigin: config.paidApiOrigin, pendingSpend });
      if (!verdict.ok) {
        refusals.push(new ToolMessage({ tool_call_id: id, name: call.name, status: "error", content: JSON.stringify({ error: verdict.refusal }) }));
        audit.push({ step: state.steps, tool: call.name, args: call.args, outcome: "refused", code: verdict.refusal.code, links: [] });
        return;
      }
      if (call.name === "reserve_spend") pendingSpend += BigInt(String(call.args.amount));
      const args = wrapperArgs(call.name, call.args, { runId: config.runId, step: state.steps, index, facts: state.facts, pinned: config.pinned });
      approved.push({ id, name: call.name, args });
    });
    return { messages: refusals, approved, audit };
  };

  const tools = async (state: SellerStateType) => {
    const messages: BaseMessage[] = [];
    const audit: AuditEntry[] = [];
    let facts = state.facts;
    for (const call of state.approved) {
      const output = (await toolNode.invoke({ lg_tool_call: { ...call, type: "tool_call" } })) as { messages: ToolMessage[] };
      const message = output.messages[0]!;
      const result = parse(message.content);
      const error = (result as { error?: { code?: string } })?.error;
      facts = { ...facts, ...applyResult(facts, call, result) };
      messages.push(message);
      audit.push({ step: state.steps, tool: call.name, args: auditArgs(call.args), outcome: error ? "error" : "ok", ...(error?.code ? { code: error.code } : {}), links: hashscanLinks(result) });
    }
    return { messages, facts, approved: [], audit };
  };

  const report = (state: SellerStateType) => {
    if (state.status === "max_steps") return {};
    const answer = textOf(lastAi(state.messages));
    return { answer, status: state.facts.repaid ? ("completed" as const) : ("incomplete" as const) };
  };

  return new StateGraph(SellerState)
    .addNode("plan", plan)
    .addNode("guard", guard)
    .addNode("tools", tools)
    .addNode("report", report)
    .addEdge(START, "plan")
    .addConditionalEdges("plan", (state) => (state.error === undefined && (lastAi(state.messages)?.tool_calls?.length ?? 0) > 0 ? "guard" : "report"), ["guard", "report"])
    .addConditionalEdges("guard", (state) => (state.approved.length > 0 ? "tools" : "plan"), ["tools", "plan"])
    .addEdge("tools", "plan")
    .addEdge("report", END)
    .compile();
}
