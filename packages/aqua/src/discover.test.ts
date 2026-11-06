import { AquaRouterAbi } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { decodeStrategy, discoverStrategies, listOpenStrategies, LOG_CHUNK_BLOCKS } from "./discover.js";
import { tierArgs } from "./types.js";

const A = "0x00000000000000000000000000000000000000a1" as const;

// ------------------------------------------------------------------ untrusted Shipped data

const AQUA = getAddress("0x000000000000000000000000000000000000a0a0");
const ROUTER = getAddress("0x000000000000000000000000000000000000beef");
const BUILDER = getAddress("0x000000000000000000000000000000000000b111");
const USDC = getAddress("0x0000000000000000000000000000000000000c01");
const RCN = getAddress("0x0000000000000000000000000000000000000c02");
const LENDER = getAddress("0x00000000000000000000000000000000000000a1");
const LENDER_ONE_TOKEN = getAddress("0x00000000000000000000000000000000000000b2");
const ATTACKER = getAddress("0x0000000000000000000000000000000000000bad");
const STRANGER = getAddress("0x0000000000000000000000000000000000000c3c");
const addrs = { aqua: AQUA, swapRouter: ROUTER, orderBuilder: BUILDER, usdc: USDC, rcn: RCN };

const ORDER_TUPLE = [
  { type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
] as const;
const orderBytes = (maker: Address): Hex => encodeAbiParameters(ORDER_TUPLE, [[maker, 1n << 250n, "0x21"]]);

function shippedLog(maker: Address, strategy: Hex) {
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes" }],
    [maker, ROUTER, keccak256(strategy), strategy],
  );
  return { address: AQUA, data, topics: encodeEventTopics({ abi: AquaRouterAbi, eventName: "Shipped" }) };
}

const revertSafeBalances = (maker: Address, token: Address) =>
  new ContractFunctionRevertedError({
    abi: AquaRouterAbi,
    functionName: "safeBalances",
    data: encodeErrorResult({
      abi: AquaRouterAbi,
      errorName: "SafeBalancesForTokenNotInActiveStrategy",
      args: [maker, ROUTER, `0x${"00".repeat(32)}`, token],
    }),
  });

/** A chain whose Aqua log holds the given Shipped events; the builder accepts every order as a credit order. */
function stubChain(logs: ReturnType<typeof shippedLog>[], safeBalances: (maker: Address) => readonly [bigint, bigint]) {
  return {
    getBlockNumber: async () => 10n,
    getLogs: async () => logs,
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      switch (functionName) {
        case "decodeLenderOrder":
          return [tierArgs("high"), 1n, USDC, RCN];
        case "safeBalances":
          return safeBalances(args[0] as Address);
        case "balanceOf":
        case "allowance":
          return 9_000_000n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    },
  } as unknown as Parameters<typeof discoverStrategies>[0];
}

describe("discoverStrategies with untrusted Shipped data", () => {
  const good = orderBytes(LENDER);
  const logs = [
    shippedLog(STRANGER, "0xdeadbeef"), // (a) not abi.encode(Order)
    shippedLog(LENDER_ONE_TOKEN, orderBytes(LENDER_ONE_TOKEN)), // (b) shipped with USDC only
    shippedLog(LENDER, good),
    shippedLog(ATTACKER, good), // (c) the lender's exact order bytes, shipped by someone else
  ];
  const balances = (maker: Address) => {
    if (maker === LENDER_ONE_TOKEN) throw revertSafeBalances(maker, RCN);
    return [4_000_000n, 0n] as const;
  };

  it("skips and reports malformed, one-token and re-shipped strategies instead of failing", async () => {
    const { strategies, skipped } = await discoverStrategies(stubChain(logs, balances), addrs);
    expect(strategies.map((s) => [s.maker, s.strategyHash])).toEqual([[LENDER, keccak256(good)]]);
    expect(strategies[0]!.virtual).toEqual({ [USDC]: 4_000_000n, [RCN]: 0n });
    expect(skipped).toEqual([
      { maker: STRANGER, strategyHash: keccak256("0xdeadbeef"), reason: "MALFORMED_STRATEGY" },
      {
        maker: LENDER_ONE_TOKEN,
        strategyHash: keccak256(orderBytes(LENDER_ONE_TOKEN)),
        reason: "BALANCES_REVERTED:SafeBalancesForTokenNotInActiveStrategy",
      },
      { maker: ATTACKER, strategyHash: keccak256(good), reason: "MAKER_MISMATCH" },
    ]);
    expect(await listOpenStrategies(stubChain(logs, balances), addrs)).toEqual(strategies);
  });

  it("still throws on transport errors", async () => {
    const down = () => {
      throw new Error("socket hang up");
    };
    await expect(discoverStrategies(stubChain(logs, down), addrs)).rejects.toThrow(/socket hang up/);
  });
});

describe("listOpenStrategies log scanning", () => {
  it("reads logs in ranges of at most 1,000 blocks", async () => {
    const ranges: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => 2_500n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([fromBlock, toBlock]);
        return [];
      },
      readContract: async () => {
        throw new Error("unexpected read");
      },
    } as unknown as Parameters<typeof listOpenStrategies>[0];
    const addrs = { aqua: A, swapRouter: A, orderBuilder: A, usdc: A, rcn: A };

    expect(await listOpenStrategies(client, addrs, { fromBlock: 10n })).toEqual([]);
    expect(LOG_CHUNK_BLOCKS).toBe(1_000n);
    expect(ranges).toEqual([
      [10n, 1_009n],
      [1_010n, 2_009n],
      [2_010n, 2_500n],
    ]);
  });
});

describe("decodeStrategy", () => {
  it("decodes abi.encode(order)", () => {
    const strategy = encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      [[A, 5n, "0x1234"]],
    );
    expect(decodeStrategy(strategy)).toEqual({ maker: "0x00000000000000000000000000000000000000A1", traits: 5n, data: "0x1234" });
  });
});
