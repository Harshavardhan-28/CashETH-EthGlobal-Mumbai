import { describe, expect, it } from "vitest";
import type { Address, Log } from "viem";
import { createAquaLogCache } from "./discover.js";

const AQUA = "0x00000000000000000000000000000000000000aa" as Address;

/** A client whose `getLogs` records each requested range and returns one fake log per block range. */
function fakeClient() {
  const ranges: [bigint, bigint][] = [];
  return {
    ranges,
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      ranges.push([fromBlock, toBlock]);
      return [{ blockNumber: fromBlock } as unknown as Log];
    },
  };
}

describe("createAquaLogCache", () => {
  it("scans the whole range once, in chunks of at most 1,000 blocks", async () => {
    const client = fakeClient();
    const cache = createAquaLogCache();
    const logs = await cache.logs(client as never, AQUA, 100n, 2_599n);
    expect(client.ranges).toEqual([[100n, 1_099n], [1_100n, 2_099n], [2_100n, 2_599n]]);
    expect(logs).toHaveLength(3);
  });

  it("on the next call fetches only the blocks after the last scan and returns old and new logs together", async () => {
    const client = fakeClient();
    const cache = createAquaLogCache();
    await cache.logs(client as never, AQUA, 100n, 2_599n);
    client.ranges.length = 0;
    const logs = await cache.logs(client as never, AQUA, 100n, 2_700n);
    expect(client.ranges).toEqual([[2_600n, 2_700n]]);
    expect(logs).toHaveLength(4);
  });

  it("fetches nothing when no new block has been produced", async () => {
    const client = fakeClient();
    const cache = createAquaLogCache();
    await cache.logs(client as never, AQUA, 100n, 500n);
    client.ranges.length = 0;
    expect(await cache.logs(client as never, AQUA, 100n, 500n)).toHaveLength(1);
    expect(client.ranges).toEqual([]);
  });

  it("starts over when asked for another contract or an earlier start block", async () => {
    const client = fakeClient();
    const cache = createAquaLogCache();
    await cache.logs(client as never, AQUA, 100n, 500n);
    client.ranges.length = 0;
    await cache.logs(client as never, "0x00000000000000000000000000000000000000bb" as Address, 100n, 500n);
    expect(client.ranges).toEqual([[100n, 500n]]);
    client.ranges.length = 0;
    await cache.logs(client as never, "0x00000000000000000000000000000000000000bb" as Address, 50n, 500n);
    expect(client.ranges).toEqual([[50n, 500n]]);
  });
});

describe("createAquaLogCache classification memo", () => {
  it("decodes a strategy's kind once and reuses it, including a 'not ours' answer", async () => {
    const cache = createAquaLogCache();
    let decodes = 0;
    const decode = async () => (decodes++, undefined);
    const hash = "0x01" as `0x${string}`;
    expect(await cache.kindOf(hash, decode)).toBeUndefined();
    expect(await cache.kindOf(hash, decode)).toBeUndefined();
    expect(decodes).toBe(1);
  });
});
