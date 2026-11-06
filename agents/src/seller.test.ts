import { readFileSync } from "node:fs";
import { ROLES } from "@casheth/shared";
import { getAddress, keccak256, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVOICE_PO_1003, INVOICE_PO_1003_DUE_UNIX, INVOICE_PO_1003_PDF } from "./fixtures.js";
import { AgentClient, ToolCallError, type ToolCaller } from "./mcpClient.js";
import { createSellerAgent, type Invoice } from "./seller.js";
import { startStack, type Stack } from "./test/stack.js";

const buyer = getAddress("0x00000000000000000000000000000000000000b7");
const invoice: Invoice = {
  buyer,
  amount: INVOICE_PO_1003.amountUnits,
  dueDate: INVOICE_PO_1003_DUE_UNIX,
  buyerRef: INVOICE_PO_1003.buyerRef,
};

describe("seller agent without a document", () => {
  it("sends its own detailsCommitment, and refuses to run without one", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client: ToolCaller = {
      async call(tool, args) {
        calls.push({ tool, args });
        return {} as never;
      },
    };
    const commitment = keccak256(toHex("doc"));
    await createSellerAgent(client).run({ invoice: { ...invoice, detailsCommitment: commitment } });
    expect(calls.map((c) => c.tool)).toEqual(["upload_receivable"]);
    expect(calls[0]!.args).toMatchObject({ detailsCommitment: commitment });
    expect(calls[0]!.args).not.toHaveProperty("documentKeccak");
    await expect(createSellerAgent(client).run({ invoice })).rejects.toThrow(/invoiceFile or invoice.detailsCommitment/);
  });
});

describe("seller agent with the demo invoice PDF", () => {
  let stack: Stack;
  let client: AgentClient;
  beforeAll(async () => {
    stack = await startStack();
    // One seller throughout: a stored document can only be attached by the agent that uploaded it.
    const agent = stack.registerAgent(ROLES.Seller);
    client = AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role: "seller", mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl });
  });
  afterAll(async () => {
    await client.close();
    await stack.stop();
  });

  it("stores the file, then commits the receivable to its keccak256", async () => {
    const result = await createSellerAgent(client).run({ invoice, invoiceFile: INVOICE_PO_1003_PDF });
    const hash = keccak256(readFileSync(INVOICE_PO_1003_PDF));
    expect(result.document).toMatchObject({ keccak256: hash, verification: { ok: true, mismatches: [] }, extracted: { amount: "6000000", buyerRef: "PO-1003" } });
    expect(result.confirmationRequest.typedData.message.detailsCommitment).toBe(hash);
  });

  it("the server refuses terms that differ from the PDF", async () => {
    const error = await createSellerAgent(client)
      .run({ invoice: { ...invoice, buyer: getAddress("0x00000000000000000000000000000000000000b8"), amount: 9_000_000n }, invoiceFile: INVOICE_PO_1003_PDF })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).code).toBe("INVOICE_MISMATCH");
  });

  it("rejects a file type the server does not accept before calling it", async () => {
    await expect(createSellerAgent({ call: async () => ({}) as never }).run({ invoice, invoiceFile: "invoice.docx" })).rejects.toThrow(/\.pdf or \.txt/);
  });
});
