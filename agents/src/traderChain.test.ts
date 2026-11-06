import { describe, expect, it, vi } from "vitest";
import { CashEthTakerAbi } from "@casheth/shared";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Address, type Hex } from "viem";
import type { BaseStrategy } from "./trader.js";
import { createTraderChain, type TraderChainClients } from "./traderChain.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const OPERATOR = addr(0xa0);
const deployment = { orderBuilder: addr(1), swapRouter: addr(2), taker: addr(3), usdc: addr(4), tUsdt: addr(5) };

const STRATEGY_BYTES = "0x1234" as Hex;
const strategy: BaseStrategy = { lender: "A", strategyHash: keccak256(STRATEGY_BYTES), maker: addr(0xb1), salt: 2n };
const order = { maker: strategy.maker, traits: 7n, data: "0xabcd" as Hex };

function filledLog(amountIn: bigint, amountOut: bigint) {
  const topics = encodeEventTopics({
    abi: CashEthTakerAbi,
    eventName: "Filled",
    args: { orderHash: strategy.strategyHash, tokenIn: deployment.usdc, tokenOut: deployment.tUsdt },
  });
  return { address: deployment.taker, topics, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amountIn, amountOut]) };
}

function clients(overrides: { receiptStatus?: "success" | "reverted"; builtStrategy?: Hex } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "buildBaseYieldOrder") return [order, overrides.builtStrategy ?? STRATEGY_BYTES];
    throw new Error(`unexpected read ${functionName}`);
  });
  const simulateContract = vi.fn(async () => ({ result: [200_000n, 199_400n, strategy.strategyHash] }));
  const writeContract = vi.fn(async () => "0xfeed" as Hex);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: overrides.receiptStatus ?? "success", logs: [filledLog(200_000n, 199_400n)] }));
  const c = { public: { readContract, simulateContract, waitForTransactionReceipt }, wallet: { account: { address: OPERATOR }, chain: { id: 296 }, writeContract } };
  return { c: c as unknown as TraderChainClients, readContract, simulateContract, writeContract };
}

describe("createTraderChain", () => {
  it("rebuilds the order from maker and salt with the 30 bps fee and accepts it when the hash matches", async () => {
    const { c, readContract } = clients();
    await expect(createTraderChain(c, deployment).orderOf(strategy)).resolves.toEqual(order);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: deployment.orderBuilder, functionName: "buildBaseYieldOrder", args: [strategy.maker, deployment.usdc, deployment.tUsdt, 30_000, 2n] }),
    );
  });

  it("rejects an order whose hash differs from the recorded strategy hash", async () => {
    const { c } = clients({ builtStrategy: "0x9999" });
    await expect(createTraderChain(c, deployment).orderOf(strategy)).rejects.toThrow(/hash/);
  });

  it("quotes as the taker contract against the router", async () => {
    const { c, simulateContract } = clients();
    await expect(createTraderChain(c, deployment).quoteOut(order, 200_000n, "0x00")).resolves.toBe(199_400n);
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: deployment.swapRouter, functionName: "quote", account: deployment.taker }),
    );
  });

  it("funds with an ERC-20 transfer to the taker and sweeps to the operator", async () => {
    const { c, writeContract } = clients();
    const chain = createTraderChain(c, deployment);
    await chain.fund(deployment.usdc, 200_000n);
    await chain.sweep(deployment.tUsdt);
    expect(writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ address: deployment.usdc, functionName: "transfer", args: [deployment.taker, 200_000n] }));
    expect(writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ address: deployment.taker, functionName: "sweep", args: [deployment.tUsdt, OPERATOR] }));
  });

  it("fills through the taker with explicit gas and reads the amounts off the Filled event", async () => {
    const { c, writeContract } = clients();
    const result = await createTraderChain(c, deployment).fill(order, 200_000n, "0x00");
    expect(result).toEqual({ txHash: "0xfeed", amountIn: 200_000n, amountOut: 199_400n });
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: deployment.taker, functionName: "fill", args: [order, 200_000n, "0x00"], gas: expect.any(BigInt) }),
    );
  });

  it("fails when a transaction is mined as reverted", async () => {
    const { c } = clients({ receiptStatus: "reverted" });
    await expect(createTraderChain(c, deployment).sweep(deployment.usdc)).rejects.toThrow(/reverted/);
  });
});
