import { describe, expect, it } from "vitest";
import { ToolCallError } from "../mcpClient.js";
import { LlmAgent, type LlmAgentOptions, type LlmToolClient } from "./agent.js";
import type { AuditEntry } from "./audit.js";
import { callReply, scriptedModel, textReply, type ReplyScript } from "./scripted.js";
import { toolDefFor, type McpToolDefinition } from "./tools.js";

const ID = `0x${"11".repeat(32)}`;
const WALLET = "0x0000000000000000000000000000000000ad06dc";
const MERCHANT = "0x0000000000000000000000000000000000002329";
const SPEND_ID = `0x${"22".repeat(32)}`;

const idem = { type: "string", minLength: 8, maxLength: 128 };
/** A fake `tools/list`: the shapes of docs/API.md, enough for the loop. */
const MCP_TOOLS: McpToolDefinition[] = [
  { name: "get_receivable_status", description: "state of a receivable", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  {
    name: "reserve_spend",
    description: "reserve budget",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, worker: { type: "string" }, spendWallet: { type: "string" }, merchant: { type: "string" }, amount: { type: "string" }, idempotencyKey: idem },
      required: ["id", "worker", "spendWallet", "merchant", "amount", "idempotencyKey"],
    },
  },
  { name: "pay_x402", description: "pay", inputSchema: { type: "object", properties: { spendId: { type: "string" }, url: { type: "string" }, idempotencyKey: idem }, required: ["spendId", "url", "idempotencyKey"] } },
  { name: "commit_spend", description: "commit", inputSchema: { type: "object", properties: { spendId: { type: "string" }, hederaTxId: { type: "string" }, idempotencyKey: idem }, required: ["spendId", "hederaTxId", "idempotencyKey"] } },
  { name: "repay_receivable", description: "repay", inputSchema: { type: "object", properties: { id: { type: "string" }, amount: { type: "string" }, idempotencyKey: idem }, required: ["id", "amount", "idempotencyKey"] } },
];

type Call = { tool: string; args: Record<string, unknown> };

function fakeClient(responses: Record<string, unknown | Error | (() => unknown)> = {}) {
  const calls: Call[] = [];
  const client: LlmToolClient = {
    listToolDefinitions: async () => MCP_TOOLS,
    call: async (tool, args) => {
      calls.push({ tool, args });
      const response = responses[tool];
      if (response instanceof Error) throw response;
      return (typeof response === "function" ? response() : response ?? {}) as never;
    },
  };
  return { client, calls };
}

function setup(script: ReplyScript, options: Partial<LlmAgentOptions> = {}, responses?: Record<string, unknown | Error | (() => unknown)>) {
  const { client, calls } = fakeClient(responses);
  const model = scriptedModel(script);
  const audit: AuditEntry[] = [];
  const agent = new LlmAgent({
    client,
    model,
    role: "worker",
    runId: "run-1",
    audit: { record: (e) => void audit.push(e) },
    log: () => {},
    ...options,
  });
  return { agent, model, calls, audit };
}

const buyFlow = { allowTools: ["reserve_spend", "pay_x402", "commit_spend"], maxSpend: 1_000_000n, pinned: { id: ID, worker: WALLET, spendWallet: WALLET } };

describe("tool definitions", () => {
  it("come from tools/list and hide the arguments the wrapper owns", () => {
    const reserve = MCP_TOOLS.find((t) => t.name === "reserve_spend")!;
    const def = toolDefFor(reserve, new Set(["idempotencyKey", "id", "worker", "spendWallet"]));
    expect(def).toMatchObject({ name: "reserve_spend", description: "reserve budget" });
    expect(Object.keys(def.inputSchema.properties as object)).toEqual(["merchant", "amount"]);
    expect(def.inputSchema.required).toEqual(["merchant", "amount"]);
  });

  it("offer read-only tools always and side-effecting tools only when allowed", async () => {
    const { agent, model } = setup([textReply("done")]);
    await agent.run("goal");
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(["get_receivable_status"]);

    const allowed = setup([textReply("done")], { allowTools: ["repay_receivable"] });
    await allowed.agent.run("goal");
    expect(allowed.model.requests[0]!.tools.map((t) => t.name)).toEqual(["get_receivable_status", "repay_receivable"]);
  });

  it("never show the model the idempotency key or a pinned argument", async () => {
    const { agent, model } = setup([textReply("done")], buyFlow);
    await agent.run("goal");
    const reserve = model.requests[0]!.tools.find((t) => t.name === "reserve_spend")!;
    expect(Object.keys(reserve.inputSchema.properties as object)).toEqual(["merchant", "amount"]);
  });
});

describe("the agent loop", () => {
  it("runs two tool calls from a scripted model, feeds the results back, then returns the answer", async () => {
    const { agent, model, calls } = setup(
      [
        callReply("Checking the receivable.", { name: "get_receivable_status", input: { id: ID } }),
        callReply("Reserving 0.25 USDC.", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "250000" } }),
        textReply("Reserved 0.25 USDC."),
      ],
      buyFlow,
      { get_receivable_status: { state: "Financed" }, reserve_spend: { spendId: SPEND_ID } },
    );
    const result = await agent.run("buy research");

    expect(result).toMatchObject({ status: "completed", answer: "Reserved 0.25 USDC.", steps: 3, spent: 250_000n });
    expect(result.toolCalls.map((c) => [c.tool, c.outcome])).toEqual([["get_receivable_status", "ok"], ["reserve_spend", "ok"]]);
    expect(calls.map((c) => c.tool)).toEqual(["get_receivable_status", "reserve_spend"]);

    const lastRequest = model.requests[2]!.messages;
    expect(lastRequest.at(-1)).toMatchObject({ role: "tool", name: "reserve_spend", isError: false, content: JSON.stringify({ spendId: SPEND_ID }) });
    expect(lastRequest[0]).toMatchObject({ role: "system" });
    expect((lastRequest[0] as { content: string }).content).toContain("spend cap for this run: 1000000");
  });

  it("stops at maxSteps", async () => {
    const { agent } = setup(() => callReply("again", { name: "get_receivable_status", input: { id: ID } }), { maxSteps: 3 });
    const result = await agent.run("loop forever");
    expect(result).toMatchObject({ status: "max_steps", steps: 3 });
    expect(result.toolCalls).toHaveLength(3);
  });

  it("reports a refusal and a truncated answer", async () => {
    const refused = setup([{ text: "", toolCalls: [], finish: "refusal" }]);
    expect((await refused.agent.run("x")).status).toBe("refused");
    const cut = setup([{ text: "partial", toolCalls: [], finish: "length" }]);
    expect(await cut.agent.run("x")).toMatchObject({ status: "truncated", answer: "partial" });
  });

  it("returns tool errors to the model as error results instead of throwing", async () => {
    const { agent, model } = setup(
      [callReply("Reserving.", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "250000" } }), textReply("The budget refused it.")],
      buyFlow,
      { reserve_spend: new ToolCallError("reserve_spend", { code: "AGENT_BUDGET_EXCEEDED", message: "over budget" }) },
    );
    const result = await agent.run("buy");
    expect(result).toMatchObject({ status: "completed", spent: 0n });
    expect(result.toolCalls[0]).toMatchObject({ outcome: "error", result: { code: "AGENT_BUDGET_EXCEEDED" } });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", isError: true });
  });

  it("answers a malformed or unknown tool call with an error and does not call the server", async () => {
    const { agent, calls } = setup([
      { text: "", finish: "tool_calls", toolCalls: [{ id: "a", name: "get_receivable_status", input: {}, argumentsError: "arguments are not valid JSON" }, { id: "b", name: "drop_tables", input: {} }] },
      textReply("ok"),
    ]);
    const result = await agent.run("x");
    expect(calls).toEqual([]);
    expect(result.toolCalls.map((c) => c.result)).toMatchObject([{ code: "BAD_INPUT" }, { code: "TOOL_NOT_ALLOWED", available: ["get_receivable_status"] }]);
  });
});

describe("guardrails", () => {
  it("refuses a side-effecting tool that allowTools does not name, and never forwards it", async () => {
    const { agent, calls } = setup([callReply("Repaying.", { name: "repay_receivable", input: { id: ID, amount: "1" } }), textReply("cannot")]);
    const result = await agent.run("repay");
    expect(calls).toEqual([]);
    expect(result.toolCalls[0]).toMatchObject({ tool: "repay_receivable", outcome: "refused", result: { code: "TOOL_NOT_ALLOWED" } });
  });

  it("refuses reserve_spend beyond the spend cap before forwarding it, counting earlier reservations", async () => {
    const { agent, calls } = setup(
      [
        callReply("First.", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "600000" } }),
        callReply("Second.", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "500000" } }),
        textReply("stopped"),
      ],
      buyFlow,
      { reserve_spend: { spendId: SPEND_ID } },
    );
    const result = await agent.run("buy twice");
    expect(calls).toHaveLength(1);
    expect(result.toolCalls[1]).toMatchObject({
      outcome: "refused",
      result: { code: "SPEND_CAP_EXCEEDED", cap: "1000000", spent: "600000", requested: "500000" },
    });
    expect(result.spent).toBe(600_000n);
  });

  it("refuses a non-numeric or zero reservation amount", async () => {
    const { agent, calls } = setup(
      [callReply("x", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "0.25" } }, { name: "reserve_spend", input: { merchant: MERCHANT, amount: "0" } }), textReply("no")],
      buyFlow,
    );
    const result = await agent.run("buy");
    expect(calls).toEqual([]);
    expect(result.toolCalls.map((c) => (c.result as { code: string }).code)).toEqual(["BAD_INPUT", "BAD_INPUT"]);
  });

  it("will not allow reserve_spend without a spend cap", () => {
    expect(() => setup([], { allowTools: ["reserve_spend"] })).toThrow(/no maxSpend cap/);
  });

  it("only pays and commits a spendId reserved in this run", async () => {
    const { agent, calls } = setup(
      [
        callReply("Paying a stranger's reservation.", { name: "pay_x402", input: { spendId: SPEND_ID, url: "http://m/research?topic=x" } }),
        callReply("Committing.", { name: "commit_spend", input: { spendId: SPEND_ID, hederaTxId: "0.0.1@1.1" } }),
        textReply("refused"),
      ],
      buyFlow,
    );
    const result = await agent.run("pay");
    expect(calls).toEqual([]);
    expect(result.toolCalls.map((c) => (c.result as { code: string }).code)).toEqual(["UNKNOWN_SPEND", "UNKNOWN_SPEND"]);
  });

  it("pins arguments over what the model supplies, so it cannot redirect the spend to another receivable or wallet", async () => {
    const { agent, calls } = setup(
      [callReply("x", { name: "reserve_spend", input: { id: "0xdead", worker: "0xbeef", spendWallet: "0xbad", merchant: MERCHANT, amount: "250000" } }), textReply("done")],
      buyFlow,
      { reserve_spend: { spendId: SPEND_ID } },
    );
    await agent.run("buy");
    expect(calls[0]!.args).toMatchObject({ id: ID, worker: WALLET, spendWallet: WALLET, merchant: MERCHANT, amount: "250000" });
  });
});

describe("idempotency keys", () => {
  const reserveCall = (input: Record<string, unknown>) => callReply("x", { name: "reserve_spend", input });
  const keyOf = (calls: Call[], i = 0) => calls[i]!.args.idempotencyKey as string;

  it("are derived by the wrapper from the run id and the arguments, never taken from the model", async () => {
    const { agent, calls } = setup(
      [reserveCall({ merchant: MERCHANT, amount: "250000", idempotencyKey: "model-chosen-key" }), textReply("done")],
      buyFlow,
      { reserve_spend: { spendId: SPEND_ID } },
    );
    await agent.run("buy");
    expect(keyOf(calls)).toMatch(/^llm-reserve_spend:[0-9a-f]{32}$/);
    expect(keyOf(calls)).not.toContain("model-chosen-key");
  });

  it("repeat for the same run and arguments, and differ across runs and arguments", async () => {
    const keyFor = async (runId: string, amount: string, extra: Record<string, unknown> = {}) => {
      const { agent, calls } = setup([reserveCall({ merchant: MERCHANT, amount, ...extra }), textReply("done")], { ...buyFlow, runId }, { reserve_spend: { spendId: SPEND_ID } });
      await agent.run("buy");
      return keyOf(calls);
    };
    const base = await keyFor("run-1", "250000");
    expect(await keyFor("run-1", "250000")).toBe(base);
    expect(await keyFor("run-1", "250000", { ttlSeconds: 60 })).not.toBe(base);
    expect(await keyFor("run-2", "250000")).not.toBe(base);
    expect(await keyFor("run-1", "300000")).not.toBe(base);
  });

  it("do not depend on the order of the model's argument keys", async () => {
    const run = async (input: Record<string, unknown>) => {
      const { agent, calls } = setup([reserveCall(input), textReply("done")], buyFlow, { reserve_spend: { spendId: SPEND_ID } });
      await agent.run("buy");
      return keyOf(calls);
    };
    expect(await run({ merchant: MERCHANT, amount: "250000" })).toBe(await run({ amount: "250000", merchant: MERCHANT }));
  });

  it("are not added to a tool whose schema has none", async () => {
    const { agent, calls } = setup([callReply("x", { name: "get_receivable_status", input: { id: ID } }), textReply("done")]);
    await agent.run("status");
    expect(calls[0]!.args).toEqual({ id: ID });
  });
});

describe("audit trail", () => {
  it("records every tool call with its outcome, refusals included, and how the run ended", async () => {
    const { agent, audit } = setup(
      [
        callReply("Reserve.", { name: "reserve_spend", input: { merchant: MERCHANT, amount: "250000" } }),
        callReply("Repay.", { name: "repay_receivable", input: { id: ID, amount: "1" } }),
        textReply("finished"),
      ],
      buyFlow,
      { reserve_spend: { spendId: SPEND_ID } },
    );
    await agent.run("buy");
    expect(audit).toMatchObject([
      { kind: "tool_call", runId: "run-1", step: 1, tool: "reserve_spend", outcome: "ok", result: { spendId: SPEND_ID } },
      { kind: "tool_call", step: 2, tool: "repay_receivable", outcome: "refused", result: { code: "TOOL_NOT_ALLOWED" } },
      { kind: "run_finished", runId: "run-1", status: "completed", steps: 3, spent: "250000", answer: "finished" },
    ]);
  });
});
