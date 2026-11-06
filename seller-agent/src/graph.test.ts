import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { stepKey } from "./keys.js";
import { runSellerAgent } from "./run.js";
import { callTool, ScriptedChatModel, SPEND_WALLET, WORKER } from "./test/fakes.js";
import { nodesVisited, setupRun } from "./test/setup.js";

const ID = "0x" + "1".repeat(64);

describe("the seller agent graph", () => {
  it("routes plan -> guard -> tools -> plan and ends in report once the model stops calling tools", async () => {
    const model = new ScriptedChatModel([callTool("get_receivable_status", { id: ID }), new AIMessage("nothing left to do")]);
    const { calls, transcript, options } = setupRun(model);

    const result = await runSellerAgent(options);

    expect(nodesVisited(transcript.entries)).toEqual(["plan", "guard", "tools", "plan", "report"]);
    expect(calls.map((c) => c.tool)).toEqual(["get_receivable_status"]);
    expect(result.answer).toBe("nothing left to do");
  });

  it("answers a refused call to the model without running it, and goes straight back to plan", async () => {
    const model = new ScriptedChatModel([callTool("pay_x402", { spendId: ID, url: "https://paid.example/price-feed" }), new AIMessage("stopping")]);
    const { calls, transcript, options } = setupRun(model);

    await runSellerAgent(options);

    expect(nodesVisited(transcript.entries)).toEqual(["plan", "guard", "plan", "report"]);
    expect(calls).toHaveLength(0);
    const answer = model.seen[1]!.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(JSON.parse(String(answer.content))).toMatchObject({ error: { code: "UNKNOWN_SPEND" } });
  });

  it("stops a model that keeps calling tools after maxSteps, with a clear error", async () => {
    const model = new ScriptedChatModel(Array.from({ length: 10 }, () => callTool("get_receivable_status", { id: ID })));
    const { options } = setupRun(model, { maxSteps: 3 });

    const result = await runSellerAgent(options);

    expect(result.status).toBe("max_steps");
    expect(result.error).toMatch(/maxSteps \(3\)/);
    expect(model.seen).toHaveLength(3);
  });

  it("derives the idempotency key from the run and step, replacing any key the model wrote", async () => {
    const model = new ScriptedChatModel([callTool("open_facility", { id: ID, idempotencyKey: "model-made-key" }), new AIMessage("ok")]);
    const { calls, options } = setupRun(model);

    await runSellerAgent(options);

    expect(calls[0]!.args).toEqual({ id: ID, idempotencyKey: stepKey("run-test", 1, 0, "open_facility") });
  });

  it("pins the research worker and its spend wallet on reserve_spend, whatever the model wrote", async () => {
    const model = new ScriptedChatModel([
      callTool("reserve_spend", { id: ID, merchant: "0x00000000000000000000000000000000000acb38", amount: "500000", worker: "0xdead" }),
      new AIMessage("ok"),
    ]);
    const { calls, options } = setupRun(model);

    await runSellerAgent(options);

    expect(calls[0]!.args).toMatchObject({ worker: WORKER.address, spendWallet: SPEND_WALLET, amount: "500000" });
  });
});
