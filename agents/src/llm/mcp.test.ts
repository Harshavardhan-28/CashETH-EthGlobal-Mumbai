/** The LLM loop over the real auth server and MCP app (fake orchestrator): real `tools/list` schemas, real token scopes. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "@casheth/shared";
import { AgentClient } from "../mcpClient.js";
import { startStack, type Stack } from "../test/stack.js";
import { LlmAgent } from "./agent.js";
import { callReply, scriptedModel, textReply } from "./scripted.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const connectWorker = () => {
  const agent = stack.registerAgent(ROLES.Worker, 2);
  return AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role: "worker", mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl });
};

describe("LlmAgent over the MCP server", () => {
  it("offers real tool schemas minus the idempotency key and answers a read-only call end to end", async () => {
    const client = connectWorker();
    const model = scriptedModel([callReply("Who is on the books?", { name: "list_agents" }), textReply("Nobody yet.")]);
    const result = await new LlmAgent({ client, model, role: "worker", allowTools: ["pay_x402"], log: () => {} }).run("look around");

    const offered = model.requests[0]!.tools;
    expect(offered.map((t) => t.name)).toEqual(expect.arrayContaining(["list_agents", "get_receivable_status", "pay_x402"]));
    expect(offered.map((t) => t.name)).not.toContain("upload_receivable");
    const pay = offered.find((t) => t.name === "pay_x402")!;
    expect(Object.keys(pay.inputSchema.properties as object)).toEqual(expect.arrayContaining(["spendId", "url"]));
    expect(pay.inputSchema.properties).not.toHaveProperty("idempotencyKey");
    expect(result).toMatchObject({ status: "completed", answer: "Nobody yet." });
    expect(result.toolCalls[0]).toMatchObject({ tool: "list_agents", outcome: "ok", result: [] });
    await client.close();
  });

  it("still meets the server's role check when allowTools names a tool the role's token lacks", async () => {
    const client = connectWorker();
    const model = scriptedModel([
      callReply("Uploading.", { name: "upload_receivable", input: { buyer: "0x00000000000000000000000000000000000000b1", amount: "1000000", dueDate: 1_900_000_000, buyerRef: "po-1", detailsCommitment: `0x${"00".repeat(32)}` } }),
      textReply("The server said no."),
    ]);
    const result = await new LlmAgent({ client, model, role: "worker", allowTools: ["upload_receivable"], log: () => {} }).run("upload");
    expect(result.toolCalls[0]).toMatchObject({ outcome: "error", result: { code: "INSUFFICIENT_SCOPE" } });
    await client.close();
  });
});
