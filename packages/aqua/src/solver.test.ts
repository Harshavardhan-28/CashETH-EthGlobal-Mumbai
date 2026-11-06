import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { planFills, preCheck, solve, strategyCapacity } from "./solver.js";
import { tierArgs, type CreditArgs, type LenderStrategy, type Tier } from "./types.js";

const USDC = "0x00000000000000000000000000000000000a11ce" as Address;
const RCN = "0x00000000000000000000000000000000000000cc" as Address;
const SELLER = "0x00000000000000000000000000000000005e11e4" as Address;
const DAY = 86_400n;
const NOW = 1_750_000_000n;

let n = 0;
function strategy(
  name: string,
  tier: Tier,
  shipped: bigint,
  over: { realUsdc?: bigint; allowance?: bigint; args?: Partial<CreditArgs>; kind?: "credit" | "base" } = {},
): LenderStrategy {
  n += 1;
  const maker = `0x${n.toString(16).padStart(40, "0")}` as Address;
  return {
    kind: over.kind ?? "credit",
    maker,
    strategyHash: `0x${name.charCodeAt(0).toString(16).padStart(64, "0")}` as Hex,
    order: { maker, traits: 0n, data: "0x" },
    args: { ...tierArgs(tier, { sellerSet: [SELLER] }), ...over.args },
    salt: BigInt(n),
    tokens: [USDC, RCN],
    virtual: { [USDC]: shipped, [RCN]: 0n },
    realUsdc: over.realUsdc ?? shipped,
    allowance: over.allowance ?? shipped,
  };
}

const USD = (x: number) => BigInt(Math.round(x * 1_000_000));

describe("planFills", () => {
  it("takes A then B and skips C when base is 7.5 USDC", () => {
    // Demo wallets: A holds 4, B 2, C 1 USDC; C shipped 3 USDC it does not have.
    const a = strategy("A", "low", USD(4));
    const b = strategy("B", "medium", USD(2));
    const c = strategy("C", "high", USD(3), { realUsdc: USD(1) });

    const plan = planFills([c, b, a], {}, USD(7.5));

    expect(plan.fills).toEqual([
      { order: a.order, amount: USD(4), aprBps: 700 },
      { order: b.order, amount: USD(2), aprBps: 850 },
    ]);
    expect(plan.total).toBe(USD(6));
    expect(plan.skipped).toEqual([{ strategyHash: c.strategyHash, reason: "UNDERFUNDED" }]);
  });

  it("skips a strategy whose real balance is below its virtual balance", () => {
    const a = strategy("A", "low", USD(4), { realUsdc: USD(4) - 1n });
    const b = strategy("B", "medium", USD(2));
    const plan = planFills([a, b], {}, USD(3));
    expect(plan.fills.map((f) => f.order.maker)).toEqual([b.order.maker]);
    expect(plan.total).toBe(USD(2));
    expect(plan.skipped).toEqual([{ strategyHash: a.strategyHash, reason: "UNDERFUNDED" }]);
  });

  it("skips the more expensive strategies once the base is covered", () => {
    const a = strategy("A", "low", USD(4));
    const b = strategy("B", "medium", USD(2));
    const c = strategy("C", "high", USD(3));
    const plan = planFills([c, a, b], {}, USD(5));
    expect(plan.fills).toEqual([
      { order: a.order, amount: USD(4), aprBps: 700 },
      { order: b.order, amount: USD(1), aprBps: 850 },
    ]);
    expect(plan.skipped).toEqual([{ strategyHash: c.strategyHash, reason: "NOT_NEEDED" }]);
  });

  it("respects minReserve", () => {
    // The wallet holds 5 USDC but must keep 3: only 2 of the 4 shipped can go out.
    const a = strategy("A", "low", USD(4), { realUsdc: USD(5), allowance: USD(5), args: { minReserve: USD(3) } });
    const b = strategy("B", "medium", USD(2), { args: { minReserve: USD(0) } });
    expect(strategyCapacity(a, a.args!.maxPerBuyer)).toBe(USD(2));
    const plan = planFills([a, b], {}, USD(6));
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(2), USD(2)]);
    expect(plan.total).toBe(USD(4));

    // A reserve at or above the wallet leaves nothing.
    const broke = strategy("Z", "low", USD(4), { realUsdc: USD(4), args: { minReserve: USD(4) } });
    expect(planFills([broke], {}, USD(1)).skipped).toEqual([{ strategyHash: broke.strategyHash, reason: "NO_CAPACITY" }]);
  });

  it("shares one maker's wallet, allowance and per-buyer headroom across its strategies", () => {
    // One lender, wallet 5 USDC, two credit strategies of 4 each: the plan may take only 5 in total.
    const cheap = strategy("P", "low", USD(4), { realUsdc: USD(5), allowance: USD(8) });
    const dear = { ...strategy("Q", "medium", USD(4), { realUsdc: USD(5), allowance: USD(8) }), maker: cheap.maker };
    dear.order = { ...dear.order, maker: cheap.maker.toUpperCase().replace("0X", "0x") as Address };
    const other = strategy("R", "high", USD(3));
    const plan = planFills([dear, cheap, other], {}, USD(7.5));
    expect(plan.fills).toEqual([
      { order: cheap.order, amount: USD(4), aprBps: 700 },
      { order: dear.order, amount: USD(1), aprBps: 850 },
      { order: other.order, amount: USD(2.5), aprBps: 1300 },
    ]);
    expect(plan.total).toBe(USD(7.5));

    // The same maker's allowance (5) and per-buyer headroom (4.5) are shared the same way.
    const allow = (h: string, over = {}) =>
      ({ ...strategy(h, "low", USD(4), { realUsdc: USD(20), allowance: USD(5), ...over }), maker: cheap.maker });
    const a1 = allow("S");
    const a2 = allow("T");
    expect(planFills([a1, a2], {}, USD(10)).total).toBe(USD(5));
    expect(planFills([allow("U", { allowance: USD(20) }), allow("V", { allowance: USD(20) })], {
      [`0x${"U".charCodeAt(0).toString(16).padStart(64, "0")}`]: USD(4.5),
      [`0x${"V".charCodeAt(0).toString(16).padStart(64, "0")}`]: USD(4.5),
    }, USD(10)).total).toBe(USD(4.5));

    // Once the maker is used up, its next strategy is skipped for capacity.
    const full = planFills([a1, a2], {}, USD(10));
    expect(full.skipped).toEqual([]);
    const drained = planFills(
      [allow("W", { allowance: USD(4) }), allow("X", { allowance: USD(4) })],
      {},
      USD(10),
    );
    expect(drained.fills.map((f) => f.amount)).toEqual([USD(4)]);
    expect(drained.skipped).toEqual([{ strategyHash: `0x${"X".charCodeAt(0).toString(16).padStart(64, "0")}`, reason: "NO_CAPACITY" }]);
  });

  it("caps each strategy at its allowance and its per-buyer headroom", () => {
    const a = strategy("A", "low", USD(4), { allowance: USD(1) });
    const b = strategy("B", "medium", USD(2));
    const plan = planFills([a, b], { [b.strategyHash]: USD(0.5) }, USD(7.5));
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(1), USD(0.5)]);
    expect(plan.total).toBe(USD(1.5));
  });

  it("ignores base-yield strategies and keeps ties in input order", () => {
    const base = strategy("Y", "low", USD(9), { kind: "base" });
    const a = strategy("A", "low", USD(1));
    const d = strategy("D", "low", USD(1));
    const plan = planFills([base, a, d], {}, USD(1.5));
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(1), USD(0.5)]);
    expect(plan.fills[0]!.order.maker).toBe(a.maker);
    expect(plan.skipped).toEqual([]);
  });

  it("plans nothing for a zero base", () => {
    const a = strategy("A", "low", USD(4));
    expect(planFills([a], {}, 0n)).toEqual({ fills: [], total: 0n, skipped: [{ strategyHash: a.strategyHash, reason: "NOT_NEEDED" }] });
  });
});

describe("preCheck", () => {
  const receivable = { dueDate: NOW + 30n * DAY };

  it("skips when tenor exceeds maxTenorDays", () => {
    const a = strategy("A", "low", USD(4), { args: { maxTenorDays: 29 } });
    expect(preCheck(a, { receivable, advanceBps: 7500, now: NOW })).toBe("TENOR_TOO_LONG");
    expect(preCheck(a, { receivable: { dueDate: NOW + 29n * DAY }, advanceBps: 7500, now: NOW })).toBeUndefined();
  });

  it("skips when the advance exceeds maxAdvanceBps, the receivable is past due or the strategy is not credit", () => {
    const a = strategy("A", "low", USD(4));
    expect(preCheck(a, { receivable, advanceBps: 8001, now: NOW })).toBe("ADVANCE_TOO_HIGH");
    expect(preCheck(a, { receivable: { dueDate: NOW }, advanceBps: 7500, now: NOW })).toBe("PAST_DUE");
    expect(preCheck({ ...a, kind: "base" }, { receivable, advanceBps: 7500, now: NOW })).toBe("NOT_CREDIT");
    expect(preCheck(a, { receivable, advanceBps: 8000, now: NOW })).toBeUndefined();
  });
});

describe("solve", () => {
  it("checks every strategy concurrently and still fills cheapest first", async () => {
    const a = strategy("A", "low", USD(1));
    const b = strategy("B", "medium", USD(1));
    const c = strategy("C", "high", USD(1));
    let inFlight = 0;
    let peak = 0;
    const slow = async <T>(value: T) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return value;
    };
    const client = {
      readContract: () => slow(0n),
      simulateContract: () => slow({ result: undefined }),
    };
    const plan = await solve(client as never, { swapRouter: "0x00000000000000000000000000000000000000f1" as Address }, {
      receivable: { id: `0x${"1".repeat(64)}` as Hex, seller: SELLER, buyer: "0x00000000000000000000000000000000000000b1" as Address, amount: USD(2), dueDate: NOW + 30n * DAY },
      strategies: [c, b, a],
      advanceBps: 7_500,
      limit: USD(10),
      facility: "0x00000000000000000000000000000000000000fa" as Address,
      coordinator: "0x00000000000000000000000000000000000000c0" as Address,
      now: NOW,
    });
    expect(peak).toBeGreaterThan(1);
    expect(plan.fills.map((f) => f.aprBps)).toEqual([700, 850]);
    expect(plan.total).toBe(USD(1.5));
  });
});
