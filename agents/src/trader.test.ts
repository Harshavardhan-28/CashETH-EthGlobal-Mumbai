import { baseTakerData, type Order } from "@casheth/aqua";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { baseStrategies, collectTrades, runTrader, serializeTrades, TradeError, type BaseStrategy, type TradeRecord, type TraderChain } from "./trader.js";

const USDC = "0x0000000000000000000000000000000000068cDa" as Address;
const TUSDT = "0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a" as Address;
const AMOUNT = 200_000n;

const strategy = (lender: string, n: number): BaseStrategy => ({
  lender,
  strategyHash: `0x${n.toString(16).padStart(64, "0")}` as Hex,
  maker: `0x${n.toString(16).padStart(40, "0")}` as Address,
  salt: 2n,
});

/** Records every call in order; the pool pays 99.7% of the input, so a round trip loses the fees. */
function fakeChain(options: { failFillAt?: number; failSweepAfterFail?: boolean } = {}) {
  const calls: string[] = [];
  const fills: { order: Order; amount: bigint; data: Hex }[] = [];
  const chain: TraderChain = {
    async orderOf(s) {
      calls.push(`orderOf ${s.lender}`);
      return { maker: s.maker, traits: 0n, data: "0x" };
    },
    async quoteOut(_order, amount) {
      calls.push(`quote ${amount}`);
      return (amount * 997n) / 1000n;
    },
    async fund(token, amount) {
      calls.push(`fund ${token === USDC ? "USDC" : "tUSDT"} ${amount}`);
    },
    async fill(order, amount, data) {
      fills.push({ order, amount, data });
      calls.push(`fill ${amount}`);
      if (fills.length === options.failFillAt) throw new Error("router reverted");
      return { txHash: `0x${fills.length.toString(16).padStart(64, "0")}` as Hex, amountIn: amount, amountOut: (amount * 997n) / 1000n };
    },
    async sweep(token) {
      calls.push(`sweep ${token === USDC ? "USDC" : "tUSDT"}`);
      if (options.failSweepAfterFail && fills.length === options.failFillAt) throw new Error("relay 502");
    },
  };
  return { chain, calls, fills };
}

const run = (chain: TraderChain, strategies: BaseStrategy[], roundTrips = 3) =>
  runTrader({ chain, strategies, tokens: { usdc: USDC, tUsdt: TUSDT }, amount: AMOUNT, roundTrips, log: () => {} });

describe("baseStrategies", () => {
  const file = {
    strategies: [
      { lender: "A", kind: "credit", maker: "0x1", salt: "1", strategyHash: "0xaa" },
      { lender: "A", kind: "base", maker: "0x00000000000000000000000000000000000000a1", salt: "2", strategyHash: "0xbb", usdc: "2000000" },
      { lender: "D", kind: "credit", maker: "0x2", salt: "1", strategyHash: "0xcc" },
      { lender: "B", kind: "base", maker: "0x00000000000000000000000000000000000000b1", salt: "2", strategyHash: "0xdd" },
    ],
  } as Parameters<typeof baseStrategies>[0];

  it("keeps the base-yield strategies in file order, with the salt as a bigint", () => {
    expect(baseStrategies(file)).toEqual([
      { lender: "A", strategyHash: "0xbb", maker: "0x00000000000000000000000000000000000000a1", salt: 2n },
      { lender: "B", strategyHash: "0xdd", maker: "0x00000000000000000000000000000000000000b1", salt: 2n },
    ]);
  });

  it("rejects a base strategy without a maker or salt", () => {
    expect(() => baseStrategies({ strategies: [{ lender: "A", kind: "base", strategyHash: "0xbb" }] })).toThrow(/maker/);
  });

  it("rejects a file without a strategies list", () => {
    expect(() => baseStrategies({})).toThrow(/strategies/);
  });
});

describe("runTrader", () => {
  it("quotes, funds the taker, fills and sweeps the output in each leg, USDC first", async () => {
    const { chain, calls } = fakeChain();
    await run(chain, [strategy("A", 1)], 1);
    expect(calls).toEqual([
      "orderOf A",
      "quote 200000",
      "fund USDC 200000",
      "fill 200000",
      "sweep tUSDT",
      "quote 199400",
      "fund tUSDT 199400",
      "fill 199400",
      "sweep USDC",
    ]);
  });

  it("does round-trips on every strategy: one record per leg, the return leg sells exactly what the first bought", async () => {
    const { chain } = fakeChain();
    const records = await run(chain, [strategy("A", 1), strategy("B", 2), strategy("C", 3)]);
    expect(records).toHaveLength(18);
    expect(records.map((r) => r.lender).join("")).toBe("AAAAAABBBBBBCCCCCC");
    expect(records.map((r) => r.direction).slice(0, 4)).toEqual(["usdc->tusdt", "tusdt->usdc", "usdc->tusdt", "tusdt->usdc"]);
    for (let i = 0; i < records.length; i += 2) {
      expect(records[i]!.amountIn).toBe(AMOUNT);
      expect(records[i + 1]!.amountIn).toBe(records[i]!.amountOut);
    }
    expect(records[0]).toMatchObject({
      lender: "A",
      strategyHash: strategy("A", 1).strategyHash,
      amountOut: 199_400n,
      txHash: `0x${"1".padStart(64, "0")}`,
      link: `https://hashscan.io/testnet/transaction/0x${"1".padStart(64, "0")}`,
    });
  });

  it("sets the quoted output as the fill's minimum, and the A->B flag from the address order", async () => {
    const { chain, fills } = fakeChain();
    await run(chain, [strategy("A", 1)], 1);
    // USDC (0x...68cDa) sorts below tUSDT, so selling USDC is A -> B.
    expect(fills.map((f) => f.data)).toEqual([
      baseTakerData({ isAToB: true, threshold: 199_400n }),
      baseTakerData({ isAToB: false, threshold: 198_801n }),
    ]);
  });

  it("returns the input to the operator and rethrows when a fill fails", async () => {
    const { chain, calls } = fakeChain({ failFillAt: 2 });
    await expect(run(chain, [strategy("A", 1)], 1)).rejects.toThrow("router reverted");
    expect(calls.slice(-3)).toEqual(["fund tUSDT 199400", "fill 199400", "sweep tUSDT"]);
  });

  it("reports each completed leg as it is confirmed, so a later failure keeps it", async () => {
    const { chain } = fakeChain({ failFillAt: 2 });
    const seen: TradeRecord[] = [];
    await expect(runTrader({ chain, strategies: [strategy("A", 1)], tokens: { usdc: USDC, tUsdt: TUSDT }, roundTrips: 1, log: () => {}, onTrade: (r) => seen.push(r) })).rejects.toBeInstanceOf(TradeError);
    expect(seen.map((r) => r.direction)).toEqual(["usdc->tusdt"]);
  });

  it("fails with a TradeError naming the lender, strategy, direction and amount, with the fill error as cause", async () => {
    const { chain } = fakeChain({ failFillAt: 2 });
    const error = await run(chain, [strategy("B", 7)], 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TradeError);
    const failure = error as TradeError;
    expect(failure).toMatchObject({ lender: "B", strategyHash: strategy("B", 7).strategyHash, direction: "tusdt->usdc", amountIn: 199_400n });
    expect((failure.cause as Error).message).toBe("router reverted");
    expect(failure.message).toMatch(/lender B tusdt->usdc 199400.*router reverted/);
  });

  it("keeps the message short for viem errors, whose full message embeds the request and response bodies", () => {
    const viemError = Object.assign(new Error("HTTP request failed.\n\nRequest body: {...}\nDetails: <html>...</html>"), { shortMessage: "HTTP request failed." });
    const failure = new TradeError({ lender: "A", strategyHash: "0xbb", direction: "usdc->tusdt", amountIn: 1n }, viemError);
    expect(failure.message).toMatch(/failed: HTTP request failed\.$/);
    expect(serializeTrades([], failure).failure?.error).toBe("HTTP request failed.");
  });

  it("attributes a failure before the fill (quote, funding) the same way", async () => {
    const { chain } = fakeChain();
    chain.quoteOut = async () => {
      throw new Error("quote reverted");
    };
    await expect(run(chain, [strategy("C", 3)], 1)).rejects.toMatchObject({ lender: "C", direction: "usdc->tusdt", amountIn: AMOUNT });
  });

  it("keeps the fill error as the cause when returning the input also fails, and records the sweep error", async () => {
    const { chain } = fakeChain({ failFillAt: 1, failSweepAfterFail: true });
    const failure = (await run(chain, [strategy("A", 1)], 1).catch((e: unknown) => e)) as TradeError;
    expect((failure.cause as Error).message).toBe("router reverted");
    expect((failure.sweepError as Error).message).toBe("relay 502");
    expect(failure.message).toMatch(/relay 502/);
  });

  it("does nothing without base strategies", async () => {
    const { chain, calls } = fakeChain();
    expect(await run(chain, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a non-positive amount or round-trip count", async () => {
    const { chain } = fakeChain();
    await expect(runTrader({ chain, strategies: [], tokens: { usdc: USDC, tUsdt: TUSDT }, amount: 0n })).rejects.toThrow(/amount/);
    await expect(run(chain, [], 0)).rejects.toThrow(/roundTrips/);
  });
});

describe("collectTrades", () => {
  const options = (chain: TraderChain) => ({ chain, strategies: [strategy("A", 1), strategy("B", 2)], tokens: { usdc: USDC, tUsdt: TUSDT }, roundTrips: 1, log: () => {} });

  it("returns every record and no failure on a clean run", async () => {
    const { records, failure } = await collectTrades(options(fakeChain().chain));
    expect(records).toHaveLength(4);
    expect(failure).toBeUndefined();
  });

  it("returns the swaps confirmed before a failed fill together with the TradeError, and stops there", async () => {
    // Fill 3 is lender B's first leg: A's two swaps are kept and B's second strategy is never touched.
    const { records, failure } = await collectTrades(options(fakeChain({ failFillAt: 3 }).chain));
    expect(records.map((r) => r.lender)).toEqual(["A", "A"]);
    expect(failure).toBeInstanceOf(TradeError);
    expect(failure).toMatchObject({ lender: "B", direction: "usdc->tusdt" });
  });
});

describe("serializeTrades", () => {
  it("writes amounts as decimal strings so the file is plain JSON", () => {
    const record = {
      lender: "A",
      strategyHash: "0xbb" as Hex,
      direction: "usdc->tusdt" as const,
      amountIn: 200_000n,
      amountOut: 199_400n,
      txHash: "0x01" as Hex,
      link: "https://hashscan.io/testnet/transaction/0x01",
    };
    expect(serializeTrades([record])).toEqual({
      network: "testnet",
      chainId: 296,
      label: "scripted volume",
      trades: [{ ...record, amountIn: "200000", amountOut: "199400" }],
    });
  });

  it("adds the failed leg, with the reason, when a run stopped on an error", () => {
    const failure = new TradeError(
      { lender: "B", strategyHash: "0xcc" as Hex, direction: "tusdt->usdc", amountIn: 199_400n },
      new Error("router reverted"),
    );
    expect(serializeTrades([], failure).failure).toEqual({
      lender: "B",
      strategyHash: "0xcc",
      direction: "tusdt->usdc",
      amountIn: "199400",
      error: "router reverted",
    });
    expect(serializeTrades([]).failure).toBeUndefined();
  });
});
