import type { Calldata } from "@casheth/agents";
import type { Env } from "@casheth/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { loadKeyRing } from "./accounts.js";
import { createWalletServer, type WalletDeps } from "./server.js";
import { ADDRESSES, approve, BUYER, BUYER_KEY, PENDING_ID, RECEIVABLE_ID, repay, SELLER_KEY, uploadResult } from "./test/fixtures.js";

const CAP = 20_000_000n;

/** A wallet whose sender records the calls and fails the one whose description is `failOn`. */
async function connect(options: { failOn?: string } = {}) {
  const sent: { account: string; call: Calldata }[] = [];
  const deps: WalletDeps = {
    ring: loadKeyRing({ BUYER_KEY, BUYER_ID: "0.0.1002", SELLER_KEY, SELLER_ID: "0.0.1001" } as unknown as Env),
    addresses: () => ADDRESSES,
    approveCap: CAP,
    sender: (held) => async (call) => {
      if (call.description === options.failOn) throw new Error("execution reverted: NOT_FINANCED");
      sent.push({ account: held.info.account, call });
      return keccak256(toHex(`tx-${sent.length}`));
    },
    balances: async () => ({ hbar: 12_500_000_000_000_000_000n, usdc: 2_000_000n }),
  };
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createWalletServer(deps).connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  return { client, call, sent };
}

describe("wallet MCP tools", () => {
  it("serves list_accounts, sign_receivable_confirmation, send_calls and get_balances", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_balances", "list_accounts", "send_calls", "sign_receivable_confirmation"]);
  });

  it("list_accounts returns labels, Hedera ids and addresses, never a key", async () => {
    const { call } = await connect();
    const { json } = await call("list_accounts", {});
    expect(json.accounts).toContainEqual({ account: "buyer", role: "buyer", accountId: "0.0.1002", address: BUYER.address });
    expect(JSON.stringify(json)).not.toContain(BUYER_KEY.slice(2));
    expect(JSON.stringify(json)).not.toContain(SELLER_KEY.slice(2));
  });

  describe("sign_receivable_confirmation", () => {
    it("signs upload_receivable's typed data as the buyer and returns what confirm_receivable takes", async () => {
      const { call } = await connect();
      const upload = uploadResult();
      const { isError, json } = await call("sign_receivable_confirmation", { account: "buyer", upload });
      expect(isError).toBe(false);
      expect(json).toMatchObject({ pendingId: PENDING_ID, receivableId: RECEIVABLE_ID, signer: BUYER.address });
      const { domain, message } = upload.confirmationRequest.typedData;
      const recovered = await recoverTypedDataAddress({
        domain,
        types: {
          ReceivableConfirmation: [
            { name: "seller", type: "address" },
            { name: "buyer", type: "address" },
            { name: "currency", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "dueDate", type: "uint64" },
            { name: "buyerRef", type: "bytes32" },
            { name: "detailsCommitment", type: "bytes32" },
            { name: "payTo", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint64" },
          ],
        },
        primaryType: "ReceivableConfirmation",
        message: { ...message, amount: BigInt(message.amount), dueDate: BigInt(message.dueDate), nonce: BigInt(message.nonce), deadline: BigInt(message.deadline) },
        signature: json.signature as Hex,
      });
      expect(recovered).toBe(BUYER.address);
    });

    it("accepts the upload result as a JSON string", async () => {
      const { call } = await connect();
      const { isError, json } = await call("sign_receivable_confirmation", { account: "buyer", upload: JSON.stringify(uploadResult()) });
      expect(isError).toBe(false);
      expect(json.signature).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it("refuses typed data for a contract other than the ReceivableRegistry", async () => {
      const { call } = await connect();
      const upload = uploadResult({ domain: { verifyingContract: ADDRESSES.creditFacility } });
      expect(await call("sign_receivable_confirmation", { account: "buyer", upload })).toMatchObject({ isError: true, json: { code: "WRONG_DOMAIN" } });
    });

    it("refuses to sign as an account that is not the confirmation's buyer", async () => {
      const { call } = await connect();
      expect(await call("sign_receivable_confirmation", { account: "seller", upload: uploadResult() })).toMatchObject({ isError: true, json: { code: "SIGNER_NOT_BUYER" } });
    });

    it("refuses an account the wallet does not hold", async () => {
      const { call } = await connect();
      expect(await call("sign_receivable_confirmation", { account: "coordinator", upload: uploadResult() })).toMatchObject({ isError: true, json: { code: "UNKNOWN_ACCOUNT" } });
    });

    it("refuses something that is not an upload_receivable result", async () => {
      const { call } = await connect();
      expect(await call("sign_receivable_confirmation", { account: "buyer", upload: { pendingId: PENDING_ID } })).toMatchObject({ isError: true, json: { code: "BAD_INPUT" } });
    });
  });

  describe("send_calls", () => {
    const repayCalls = () => [approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, 2_000_000n), repay(2_000_000n)];

    it("sends repay_receivable's calls in order from the named account and links each transaction", async () => {
      const { call, sent } = await connect();
      const { isError, json } = await call("send_calls", { account: "buyer", calls: repayCalls() });
      expect(isError).toBe(false);
      expect(sent.map((s) => s.call.description)).toEqual(repayCalls().map((c) => c.description));
      expect(sent.every((s) => s.account === "buyer")).toBe(true);
      expect(json).toMatchObject({ account: "buyer", from: BUYER.address });
      expect(json.sent).toHaveLength(2);
      expect(json.sent[1]).toMatchObject({ index: 1, description: repay(1n).description, hashscan: `https://hashscan.io/testnet/transaction/${json.sent[1].txHash}` });
    });

    it("refuses a batch with a call outside the allowlist and sends nothing", async () => {
      const { call, sent } = await connect();
      const calls = [approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, 1n), { ...repay(1n), to: ADDRESSES.creditFacility! }];
      expect(await call("send_calls", { account: "buyer", calls })).toMatchObject({ isError: true, json: { code: "TARGET_NOT_ALLOWED", index: 1 } });
      expect(sent).toEqual([]);
    });

    it("refuses an approval above the cap and sends nothing", async () => {
      const { call, sent } = await connect();
      const calls = [approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, CAP + 1n), repay(CAP + 1n)];
      expect(await call("send_calls", { account: "buyer", calls })).toMatchObject({ isError: true, json: { code: "APPROVE_ABOVE_CAP" } });
      expect(sent).toEqual([]);
    });

    it("stops at the first failed call and reports what was already sent", async () => {
      const { call, sent } = await connect({ failOn: repay(1n).description });
      const calls = [...repayCalls(), approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, 1n)];
      const { isError, json } = await call("send_calls", { account: "buyer", calls });
      expect(isError).toBe(true);
      expect(json).toMatchObject({ code: "CALL_FAILED", failedIndex: 1, failedCall: repay(1n).description, reason: "execution reverted: NOT_FINANCED" });
      expect(json.sent).toHaveLength(1);
      expect(json.sent[0].hashscan).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/0x/);
      expect(sent).toHaveLength(1);
    });

    it("replays an identical batch it already sent instead of paying twice", async () => {
      const { call, sent } = await connect();
      const first = await call("send_calls", { account: "buyer", calls: repayCalls() });
      const again = await call("send_calls", { account: "buyer", calls: repayCalls() });
      expect(sent).toHaveLength(2);
      expect(again.json).toEqual({ ...first.json, replayed: true });
    });

    it("refuses an account the wallet does not hold", async () => {
      const { call, sent } = await connect();
      expect(await call("send_calls", { account: "worker", calls: repayCalls() })).toMatchObject({ isError: true, json: { code: "UNKNOWN_ACCOUNT" } });
      expect(sent).toEqual([]);
    });
  });

  it("get_balances returns HBAR and USDC for the account", async () => {
    const { call } = await connect();
    expect((await call("get_balances", { account: "buyer" })).json).toEqual({
      account: "buyer",
      accountId: "0.0.1002",
      address: BUYER.address,
      hbar: "12.5",
      usdc: "2000000",
      usdcDisplay: "2",
    });
  });
});
