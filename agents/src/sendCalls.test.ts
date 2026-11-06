import { createWalletClient, custom, getAddress, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { SendCallsError, sendInOrder, walletCallSender, type AgentWallet, type Calldata } from "./sendCalls.js";

const call = (n: number): Calldata => ({ to: getAddress(`0x${n.toString(16).padStart(40, "0")}`), data: "0x01", description: `call ${n}` });
const hashOf = (n: number) => keccak256(toHex(`tx${n}`));

describe("sendInOrder", () => {
  it("names the failed call and carries the hashes already sent", async () => {
    const send = async (c: Calldata) => {
      if (c.description === "call 2") throw new Error("execution reverted");
      return hashOf(1);
    };
    const error = await sendInOrder(send, [call(1), call(2), call(3)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendCallsError);
    expect(error).toMatchObject({ index: 1, sent: [hashOf(1)], reason: "execution reverted" });
    expect((error as Error).message).toMatch(/^call 2 of 3 \(call 2\) failed, already sent: 0x[0-9a-f]{64}: execution reverted$/);
  });
});

/** A chain-296 JSON-RPC fake that records the requests and fails `eth_call` for the `reverting` target. */
function fakeWallet(reverting?: Hex) {
  const requests: { method: string; params: unknown }[] = [];
  const txHash = hashOf(9);
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown }) {
      requests.push({ method, params });
      const first = (Array.isArray(params) ? params[0] : undefined) as { to?: string } | undefined;
      switch (method) {
        case "eth_chainId":
          return "0x128";
        case "eth_call":
          if (reverting && first?.to?.toLowerCase() === reverting.toLowerCase()) throw new Error("execution reverted: NOT_FINANCED");
          return "0x";
        case "eth_estimateGas":
          return "0x186a0"; // 100_000
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_gasPrice":
          return "0x1";
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_getBlockByNumber":
          return { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", hash: hashOf(1), transactions: [] };
        case "eth_sendRawTransaction":
          return txHash;
        case "eth_getTransactionReceipt":
          return { transactionHash: txHash, status: "0x1", blockNumber: "0x1", blockHash: hashOf(1), logs: [], gasUsed: "0x1", cumulativeGasUsed: "0x1", transactionIndex: "0x0", from: "0x", to: "0x", type: "0x0", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}` };
        case "eth_blockNumber":
          return "0x2";
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  const account = privateKeyToAccount(keccak256(toHex("wallet-key")));
  const chain = { id: 296, name: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: ["http://fake"] } } };
  const wallet = createWalletClient({ account, chain, transport, pollingInterval: 1 }) as unknown as AgentWallet;
  return { wallet, requests, txHash };
}

describe("walletCallSender", () => {
  it("dry-runs the call, then sends it with the estimate plus 30% and waits for a successful receipt", async () => {
    const { wallet, requests, txHash } = fakeWallet();
    expect(await walletCallSender(wallet)(call(1))).toBe(txHash);
    const methods = requests.map((r) => r.method);
    expect(methods).toContain("eth_call");
    expect(methods.indexOf("eth_call")).toBeLessThan(methods.indexOf("eth_sendRawTransaction"));
    const raw = requests.find((r) => r.method === "eth_sendRawTransaction")!.params as [Hex];
    expect(parseTransaction(raw[0]).gas).toBe(130_000n);
  });

  it("never sends a call whose dry run reverts", async () => {
    const { wallet, requests } = fakeWallet(call(1).to);
    await expect(walletCallSender(wallet)(call(1))).rejects.toThrow(/NOT_FINANCED/);
    expect(requests.map((r) => r.method)).not.toContain("eth_sendRawTransaction");
  });
});
