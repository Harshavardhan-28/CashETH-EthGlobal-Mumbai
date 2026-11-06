import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashReceivableConfirmation, receivableConfirmationTypedData, receivableDomain, ROLES } from "@casheth/shared";
import { keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { confirmationMessage, createBuyerAgent, signConfirmation } from "./buyer.js";
import { AgentClient, type ToolCaller } from "./mcpClient.js";
import { createSellerAgent, type UploadResult } from "./seller.js";
import { ADDRS, kyaAgent, NOW, startStack, type Stack } from "./test/stack.js";

/** Pinned by `test_vector_hashConfirmation` in contracts/test/ReceivableRegistry.t.sol (see packages/shared eip712.test.ts). */
const VECTOR_DIGEST = "0xa92d06494ee4362f2ede26cdd00a3a6c491fec7cdf5f3741d7240cb3f3d777e0";

/** The typed data exactly as `upload_receivable` returns it: uint fields are decimal strings. */
const wireTypedData = (buyer: Address = "0x2222222222222222222222222222222222222222") => ({
  domain: { name: "AgentReceivables", version: "1", chainId: 296, verifyingContract: "0x4444444444444444444444444444444444444444" as Address },
  message: {
    seller: "0x1111111111111111111111111111111111111111" as Address,
    buyer,
    currency: "0x0000000000000000000000000000000000068cDa" as Address,
    amount: "10000000",
    dueDate: "1800000000",
    buyerRef: keccak256(toHex("PO-1001")),
    detailsCommitment: keccak256(toHex("doc")),
    payTo: "0x3333333333333333333333333333333333333333" as Address,
    nonce: "0",
    deadline: "1799999000",
  },
});

const account = privateKeyToAccount(`0x${"0b".repeat(32)}` as Hex);

describe("confirmation typed data", () => {
  it("converts the wire strings so the digest equals the pinned Solidity vector", () => {
    const { domain, message } = confirmationMessage(wireTypedData());
    expect(hashReceivableConfirmation(domain, message)).toBe(VECTOR_DIGEST);
  });

  it("signs as the buyer: the signature recovers to the buyer's address", async () => {
    const wire = wireTypedData(account.address);
    const signature = await signConfirmation(account, wire);
    const { domain, message } = confirmationMessage(wire);
    expect(await recoverTypedDataAddress({ ...receivableConfirmationTypedData(domain, message), signature })).toBe(account.address);
  });

  it("refuses typed data that names another buyer", async () => {
    await expect(signConfirmation(account, wireTypedData())).rejects.toThrow(/another buyer/);
  });

  it("signs under the AgentReceivables/1 domain whatever name and version the server sends", () => {
    const wire = wireTypedData();
    const { domain } = confirmationMessage({ ...wire, domain: { ...wire.domain, name: "Other", version: "9" } });
    expect(domain).toEqual(receivableDomain(296, "0x4444444444444444444444444444444444444444"));
  });
});

describe("seller uploads, buyer confirms (through the real auth and MCP servers)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  it("registers the receivable on the chain and returns the credit decision", async () => {
    const sellerKya = stack.registerAgent(ROLES.Seller, 2);
    const buyerKya = stack.registerAgent(ROLES.Buyer, 3);
    const { chain } = stack.orchestrator;
    chain.agents.set(sellerKya.address.toLowerCase(), kyaAgent(2, ROLES.Seller, "seller-co"));
    chain.agents.set(buyerKya.address.toLowerCase(), kyaAgent(3, ROLES.Buyer, "buyer-co"));
    chain.reps.set(buyerKya.address.toLowerCase(), { onTime: 2, late: 0, defaults: 0 });

    const connect = (agent: typeof sellerKya, role: "seller" | "buyer") =>
      AgentClient.connect({ agentKey: agent.privateKey, uaid: agent.uaid, role, mandateHash: agent.record.mandateHash, mcpUrl: stack.mcpUrl });
    const seller = createSellerAgent(connect(sellerKya, "seller"));
    const buyer = createBuyerAgent({ client: connect(buyerKya, "buyer"), account: privateKeyToAccount(buyerKya.privateKey) });

    const upload: UploadResult = await seller.run({
      invoice: {
        buyer: buyerKya.address,
        amount: 10_000_000_000n,
        dueDate: NOW + 30n * 86_400n,
        buyerRef: "PO-2001",
        detailsCommitment: keccak256(toHex("invoice-doc")),
      },
    });
    expect(upload.confirmationRequest.typedData.message.payTo).toBe(ADDRS.repaymentRouter);

    const confirmed = await buyer.confirm(upload);
    expect(confirmed).toMatchObject({ id: upload.id, decision: { approved: true } });
    expect(chain.sent.map((s) => s.call.to)).toEqual([ADDRS.receivableRegistry]);
  });
});

describe("buyer repay", () => {
  const id = keccak256(toHex("receivable-1"));
  const calls = [
    { to: ADDRS.usdc, data: "0x01" as Hex, description: "USDC.approve(router, 5)" },
    { to: ADDRS.repaymentRouter, data: "0x02" as Hex, description: "RepaymentRouter.repay" },
  ];

  const fakeClient = (result: unknown) => {
    const calledWith: { tool: string; args: Record<string, unknown> }[] = [];
    const client: ToolCaller = { call: async (tool, args) => (calledWith.push({ tool, args }), result as never) };
    return { client, calledWith };
  };

  it("sends the approve and repay calldata in order when the server returns calldata", async () => {
    const { client, calledWith } = fakeClient({ id, mode: "calldata", calls });
    const order: string[] = [];
    const send = async (call: { description: string }) => (order.push(call.description), `0x0${order.length}` as Hex);
    const buyer = createBuyerAgent({ client, account, send });
    const result = await buyer.repay(id, 5_000_000n);
    expect(calledWith[0]).toMatchObject({ tool: "repay_receivable", args: { id, amount: "5000000" } });
    expect(order).toEqual(["USDC.approve(router, 5)", "RepaymentRouter.repay"]);
    expect(result).toMatchObject({ mode: "sent", txHashes: ["0x01", "0x02"] });
  });

  it("returns the server's result untouched when it sent the transactions itself", async () => {
    const sentResult = { id, mode: "sent", txHash: "0xab", state: "Repaid" };
    const buyer = createBuyerAgent({ client: fakeClient(sentResult).client, account });
    expect(await buyer.repay(id, 5_000_000n)).toEqual(sentResult);
  });

  it("cannot sign calldata without a sender", async () => {
    const buyer = createBuyerAgent({ client: fakeClient({ id, mode: "calldata", calls }).client, account });
    await expect(buyer.repay(id, 5_000_000n)).rejects.toThrow(/no call sender/);
  });
});
