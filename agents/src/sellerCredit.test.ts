import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { ToolCaller } from "./mcpClient.js";
import { createSellerAgent, type Invoice } from "./seller.js";

const buyer: Address = "0x00000000000000000000000000000000000000b1";
const worker: Address = "0x00000000000000000000000000000000000000d1";
const merchant: Address = "0x0000000000000000000000000000000000000a01";
const id = keccak256(toHex("PO-1"));
const invoice: Invoice = { buyer, amount: 8_000_000n, dueDate: 1_800_000_000n, buyerRef: "PO-1", detailsCommitment: keccak256(toHex("details")) };

function setup(result: unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: ToolCaller = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return result as never;
    },
  };
  return { calls, client };
}

describe("sellerAgent.run", () => {
  it("uploads with a key that is stable for the invoice and distinct for another submission", async () => {
    const keyOf = async (submission?: string) => {
      const { client, calls } = setup({});
      await createSellerAgent(client).run({ invoice, ...(submission ? { submission } : {}) });
      return calls[0]!.args.idempotencyKey;
    };
    const first = await keyOf();
    expect(await keyOf()).toBe(first);
    expect(await keyOf("again")).not.toBe(first);
  });
});

describe("sellerAgent credit calls", () => {
  it("asks for quotes and opens the facility with the receivable id", async () => {
    const { client, calls } = setup({});
    const seller = createSellerAgent(client);
    await seller.quotes(id);
    await seller.openFacility(id);
    expect(calls.map((c) => [c.tool, c.args.id])).toEqual([["get_quotes", id], ["open_facility", id]]);
    expect(calls[1]!.args.idempotencyKey).toEqual(expect.any(String));
  });

  const budgets = [{ worker, alloc: 1_000_000n, maxPerTx: 500_000n, maxDaily: 2_000_000n, merchants: [merchant] }];

  it("sends budgets as unit strings and returns the transaction hash the server sent", async () => {
    const { client, calls } = setup({ mode: "sent", txHash: "0xaa" });
    expect(await createSellerAgent(client).setBudgets(id, budgets)).toEqual({ txHash: "0xaa" });
    expect(calls[0]!.args.budgets).toEqual([{ worker, alloc: "1000000", maxPerTx: "500000", maxDaily: "2000000", merchants: [merchant] }]);
  });

  it("sends the calldata itself when the server does not hold the seller key", async () => {
    const calldata = { to: merchant, data: "0x01" as Hex, description: "CreditFacility.setBudgets" };
    const { client } = setup({ mode: "calldata", calls: [calldata] });
    const sent: string[] = [];
    const seller = createSellerAgent(client, async (call) => (sent.push(call.description), "0xbb" as Hex));
    expect(await seller.setBudgets(id, budgets)).toEqual({ txHash: "0xbb" });
    expect(sent).toEqual(["CreditFacility.setBudgets"]);
  });
});
