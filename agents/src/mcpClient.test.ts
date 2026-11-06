import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "@casheth/shared";
import { AgentClient, ToolCallError, freshKey, idempotencyKey } from "./mcpClient.js";
import { startStack, type Stack } from "./test/stack.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

function connectSeller(extra: Partial<Parameters<typeof AgentClient.connect>[0]> = {}) {
  const agent = stack.registerAgent(ROLES.Seller);
  return AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role: "seller", mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl, ...extra });
}

describe("AgentClient", () => {
  it("obtains a token and lists tools against a local MCP server", async () => {
    const client = connectSeller();
    const before = stack.tokenRequests();
    const tools = await client.listTools();
    expect(tools).toEqual(expect.arrayContaining(["upload_receivable", "reserve_spend", "fund_agents"]));
    expect(stack.tokenRequests() - before).toBe(1);
    await client.close();
  });

  it("calls a tool and returns its parsed JSON", async () => {
    const client = connectSeller();
    expect(await client.call("list_agents", {})).toEqual([]);
    await client.close();
  });

  it("throws a ToolCallError carrying the server's error code", async () => {
    const client = connectSeller();
    const error = await client.call("confirm_receivable", { pendingId: `0x${"0".repeat(64)}`, signature: "0x00", idempotencyKey: "key-12345678" }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect(error.code).toBe("INSUFFICIENT_SCOPE");
    await client.close();
  });

  it("gets a new token and retries once when the server answers 401", async () => {
    let corrupted = false;
    const client = connectSeller({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const isMcp = request.url === stack.mcpUrl && request.headers.has("authorization");
        if (isMcp && !corrupted) {
          corrupted = true;
          request.headers.set("authorization", "Bearer expired");
        }
        return fetch(request);
      },
    });
    const before = stack.tokenRequests();
    expect(await client.call("list_agents", {})).toEqual([]);
    expect(stack.tokenRequests() - before).toBe(2);
    await client.close();
  });

  it("refuses a token whose role is not the one the agent was configured with", async () => {
    const agent = stack.registerAgent(ROLES.Lender);
    const client = AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role: "seller", mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl });
    await expect(client.listTools()).rejects.toThrow(/role/);
  });

  it("surfaces the authorization server's refusal for an agent below KYA level 1", async () => {
    const agent = stack.registerAgent(ROLES.Seller, 0);
    const client = AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role: "seller", mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl });
    await expect(client.listTools()).rejects.toThrow(/token request failed/);
  });
});

describe("idempotency keys", () => {
  it("is stable for the same scope and parts and fits the server's 8-128 character window", () => {
    const key = idempotencyKey("upload", "a", "b");
    expect(key).toBe(idempotencyKey("upload", "a", "b"));
    expect(key).not.toBe(idempotencyKey("upload", "a", "c"));
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("freshKey never repeats", () => {
    expect(freshKey("repay")).not.toBe(freshKey("repay"));
  });
});
