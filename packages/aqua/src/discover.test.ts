import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import { decodeStrategy, listOpenStrategies, LOG_CHUNK_BLOCKS } from "./discover.js";

const A = "0x00000000000000000000000000000000000000a1" as const;

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
