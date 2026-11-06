import { ToolCallError } from "@casheth/agents";
import { describe, expect, it } from "vitest";
import { buildToolset } from "./toolset.js";
import { fakeSession, type RecordedCall } from "./test/fakes.js";

const local = {
  httpGet: async () => ({ status: 402 }),
  confirm: async () => ({ id: "0x1" }),
  repay: async () => ({ id: "0x1", mode: "sent" }),
};

async function setup(answers: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = [];
  const toolset = await buildToolset({ seller: fakeSession("seller", calls, answers), worker: fakeSession("worker", calls, answers), local });
  return { calls, toolset };
}

const names = (specs: { function: { name: string } }[]) => specs.map((s) => s.function.name).sort();

describe("buildToolset", () => {
  it("offers the model the seller's and the worker's CashETH tools from tools/list plus the local tools, nothing else", async () => {
    const { toolset } = await setup();
    expect(names(toolset.specs)).toEqual(
      [
        "commit_spend", "get_quotes", "get_receivable_status", "http_get", "open_facility", "pay_x402",
        "request_buyer_confirmation", "request_buyer_repayment", "reserve_spend", "set_budgets",
        "upload_invoice_document", "upload_receivable",
      ].sort(),
    );
  });

  it("hides the arguments the wrapper fills in (idempotency keys, file content, the worker's wallet)", async () => {
    const { toolset } = await setup();
    const params = (name: string) => Object.keys((toolset.specs.find((s) => s.function.name === name)!.function.parameters as { properties: object }).properties);
    expect(params("reserve_spend").sort()).toEqual(["amount", "id", "merchant", "ttlSeconds"]);
    expect(params("upload_invoice_document")).toEqual(["receivableRef"]);
    expect(params("upload_receivable")).not.toContain("seller");
    expect(params("pay_x402")).not.toContain("idempotencyKey");
  });

  it("sends seller tools through the seller session and spending tools through the worker session", async () => {
    const { calls, toolset } = await setup();
    const run = (name: string, args: Record<string, unknown>) => toolset.tools.find((t) => t.name === name)!.invoke(args);
    await run("open_facility", { id: "0x1", idempotencyKey: "k-00000001" });
    await run("reserve_spend", { amount: "500000", idempotencyKey: "k-00000002" });
    await run("pay_x402", { spendId: "0x2", url: "https://paid.example/", idempotencyKey: "k-00000003" });
    expect(calls.map((c) => `${c.session}:${c.tool}`)).toEqual(["seller:open_facility", "worker:reserve_spend", "worker:pay_x402"]);
    expect(calls[1]!.args).toEqual({ amount: "500000", idempotencyKey: "k-00000002" });
  });

  it("returns a tool error as JSON with its code instead of throwing", async () => {
    const { toolset } = await setup({ open_facility: new ToolCallError("open_facility", { code: "NO_ELIGIBLE_LIQUIDITY", message: "no lender" }) });
    const out = await toolset.tools.find((t) => t.name === "open_facility")!.invoke({ id: "0x1" });
    expect(JSON.parse(String(out))).toMatchObject({ error: { code: "NO_ELIGIBLE_LIQUIDITY" } });
  });

  it("fails fast when the server does not offer a tool the story needs", async () => {
    const calls: RecordedCall[] = [];
    const seller = { ...fakeSession("seller", calls), listToolDefinitions: async () => [] };
    await expect(buildToolset({ seller, worker: fakeSession("worker", calls), local })).rejects.toThrow(/upload_invoice_document/);
  });
});
