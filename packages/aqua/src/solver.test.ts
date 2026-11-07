import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { planFills, preCheck, solve, strategyCapacity } from "./solver.js";
import { creditArgs, type CreditArgs, type LenderStrategy, type RiskSlab } from "./types.js";

const USDC = "0x00000000000000000000000000000000000a11ce" as Address;
const RCN = "0x00000000000000000000000000000000000000cc" as Address;
const SELLER = "0x00000000000000000000000000000000005e11e4" as Address;
const DAY = 86_400n;
const NOW = 1_750_000_000n;
/** Every plan pays the seller's own rate (a new seller: medium risk, 11%). */
const PRICE = { slab: "medium", aprBps: 1100 } as const;
const ALL: RiskSlab[] = ["low", "medium", "high"];

let n = 0;
function strategy(
  name: string,
  slabs: RiskSlab[],
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
    args: { ...creditArgs(slabs, { sellerSet: [SELLER] }), ...over.args },
    salt: BigInt(n),
    tokens: [USDC, RCN],
    virtual: { [USDC]: shipped, [RCN]: 0n },
    realUsdc: over.realUsdc ?? shipped,
    allowance: over.allowance ?? shipped,
  };
}

const USD = (x: number) => BigInt(Math.round(x * 1_000_000));

describe("planFills", () => {
  it("fills every strategy at the seller's rate: A then B, C skipped, when base is 7.5 USDC", () => {
    // Demo wallets: A holds 4, B 2, C 1 USDC; C shipped 3 USDC it does not have.
    const a = strategy("A", ALL, USD(4));
    const b = strategy("B", ALL, USD(2));
    const c = strategy("C", ALL, USD(3), { realUsdc: USD(1) });

    const plan = planFills([c, b, a], {}, USD(7.5), PRICE.aprBps);

    expect(plan.fills).toEqual([
      { order: a.order, amount: USD(4), aprBps: 1100 },
      { order: b.order, amount: USD(2), aprBps: 1100 },
    ]);
    expect(plan.total).toBe(USD(6));
    expect(plan.skipped).toEqual([{ strategyHash: c.strategyHash, reason: "UNDERFUNDED" }]);
  });

  it("skips a strategy whose real balance is below its virtual balance", () => {
    const a = strategy("A", ALL, USD(4), { realUsdc: USD(4) - 1n });
    const b = strategy("B", ALL, USD(2));
    const plan = planFills([a, b], {}, USD(3), PRICE.aprBps);
    expect(plan.fills.map((f) => f.order.maker)).toEqual([b.order.maker]);
    expect(plan.total).toBe(USD(2));
    expect(plan.skipped).toEqual([{ strategyHash: a.strategyHash, reason: "UNDERFUNDED" }]);
  });

  it("fills the largest strategies first (fewer fills) and skips the rest once the base is covered", () => {
    const a = strategy("A", ALL, USD(4));
    const b = strategy("B", ALL, USD(2));
    const c = strategy("C", ALL, USD(3));
    const plan = planFills([b, c, a], {}, USD(5), PRICE.aprBps);
    expect(plan.fills).toEqual([
      { order: a.order, amount: USD(4), aprBps: 1100 },
      { order: c.order, amount: USD(1), aprBps: 1100 },
    ]);
    expect(plan.skipped).toEqual([{ strategyHash: b.strategyHash, reason: "NOT_NEEDED" }]);
  });

  it("respects minReserve", () => {
    // The wallet holds 5 USDC but must keep 3: only 2 of the 4 shipped can go out.
    const a = strategy("A", ALL, USD(4), { realUsdc: USD(5), allowance: USD(5), args: { minReserve: USD(3) } });
    const b = strategy("B", ALL, USD(2), { args: { minReserve: USD(0) } });
    expect(strategyCapacity(a, a.args!.maxPerBuyer)).toBe(USD(2));
    const plan = planFills([a, b], {}, USD(6), PRICE.aprBps);
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(2), USD(2)]);
    expect(plan.total).toBe(USD(4));

    // A reserve at or above the wallet leaves nothing.
    const broke = strategy("Z", ALL, USD(4), { realUsdc: USD(4), args: { minReserve: USD(4) } });
    expect(planFills([broke], {}, USD(1), PRICE.aprBps).skipped).toEqual([{ strategyHash: broke.strategyHash, reason: "NO_CAPACITY" }]);
  });

  it("shares one maker's wallet, allowance and per-buyer headroom across its strategies", () => {
    // One lender, wallet 5 USDC, two credit strategies of 4 each: the plan may take only 5 in total.
    const cheap = strategy("P", ALL, USD(4), { realUsdc: USD(5), allowance: USD(8) });
    const dear = { ...strategy("Q", ALL, USD(4), { realUsdc: USD(5), allowance: USD(8) }), maker: cheap.maker };
    dear.order = { ...dear.order, maker: cheap.maker.toUpperCase().replace("0X", "0x") as Address };
    const other = strategy("R", ALL, USD(3));
    const plan = planFills([dear, cheap, other], {}, USD(7.5), PRICE.aprBps);
    expect(plan.fills).toEqual([
      { order: dear.order, amount: USD(4), aprBps: 1100 },
      { order: cheap.order, amount: USD(1), aprBps: 1100 },
      { order: other.order, amount: USD(2.5), aprBps: 1100 },
    ]);
    expect(plan.total).toBe(USD(7.5));

    // The same maker's allowance (5) and per-buyer headroom (4.5) are shared the same way.
    const allow = (h: string, over = {}) =>
      ({ ...strategy(h, ALL, USD(4), { realUsdc: USD(20), allowance: USD(5), ...over }), maker: cheap.maker });
    const a1 = allow("S");
    const a2 = allow("T");
    expect(planFills([a1, a2], {}, USD(10), PRICE.aprBps).total).toBe(USD(5));
    expect(planFills([allow("U", { allowance: USD(20) }), allow("V", { allowance: USD(20) })], {
      [`0x${"U".charCodeAt(0).toString(16).padStart(64, "0")}`]: USD(4.5),
      [`0x${"V".charCodeAt(0).toString(16).padStart(64, "0")}`]: USD(4.5),
    }, USD(10), PRICE.aprBps).total).toBe(USD(4.5));

    // Once the maker is used up, its next strategy is skipped for capacity.
    const full = planFills([a1, a2], {}, USD(10), PRICE.aprBps);
    expect(full.skipped).toEqual([]);
    const drained = planFills(
      [allow("W", { allowance: USD(4) }), allow("X", { allowance: USD(4) })],
      {},
      USD(10),
      PRICE.aprBps,
    );
    expect(drained.fills.map((f) => f.amount)).toEqual([USD(4)]);
    expect(drained.skipped).toEqual([{ strategyHash: `0x${"X".charCodeAt(0).toString(16).padStart(64, "0")}`, reason: "NO_CAPACITY" }]);
  });

  it("caps each strategy at its allowance and its per-buyer headroom", () => {
    const a = strategy("A", ALL, USD(4), { allowance: USD(1) });
    const b = strategy("B", ALL, USD(2));
    const plan = planFills([a, b], { [b.strategyHash]: USD(0.5) }, USD(7.5), PRICE.aprBps);
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(1), USD(0.5)]);
    expect(plan.total).toBe(USD(1.5));
  });

  it("ignores base-yield strategies and keeps ties in input order", () => {
    const base = strategy("Y", ALL, USD(9), { kind: "base" });
    const a = strategy("A", ALL, USD(1));
    const d = strategy("D", ALL, USD(1));
    const plan = planFills([base, a, d], {}, USD(1.5), PRICE.aprBps);
    expect(plan.fills.map((f) => f.amount)).toEqual([USD(1), USD(0.5)]);
    expect(plan.fills[0]!.order.maker).toBe(a.maker);
    expect(plan.skipped).toEqual([]);
  });

  it("plans nothing for a zero base", () => {
    const a = strategy("A", ALL, USD(4));
    expect(planFills([a], {}, 0n, PRICE.aprBps)).toEqual({ fills: [], total: 0n, skipped: [{ strategyHash: a.strategyHash, reason: "NOT_NEEDED" }] });
  });
});

describe("preCheck", () => {
  const receivable = { dueDate: NOW + 30n * DAY, seller: SELLER };
  const at = (over: Partial<Parameters<typeof preCheck>[1]> = {}) => ({ receivable, advanceBps: 7500, now: NOW, slab: PRICE.slab, ...over });

  it("skips a strategy that does not fund the seller's slab", () => {
    const lowOnly = strategy("L", ["low"], USD(4));
    expect(preCheck(lowOnly, at())).toBe("SLAB_NOT_FUNDED");
    expect(preCheck(lowOnly, at({ slab: "low" }))).toBeUndefined();
  });

  it("skips a strategy whose seller list leaves the seller out, and accepts any seller without a list", () => {
    const other = strategy("O", ALL, USD(4), { args: { sellerSet: ["0x00000000000000000000000000000000000000e1"] } });
    expect(preCheck(other, at())).toBe("SELLER_NOT_LISTED");
    const open = strategy("N", ALL, USD(4), { args: { sellerSet: [] } });
    expect(preCheck(open, at())).toBeUndefined();
    const listed = strategy("S", ALL, USD(4), { args: { sellerSet: [SELLER.toUpperCase().replace("0X", "0x") as Address] } });
    expect(preCheck(listed, at()), "addresses compare case-insensitively").toBeUndefined();
  });

  it("skips when tenor exceeds maxTenorDays", () => {
    const a = strategy("A", ALL, USD(4), { args: { maxTenorDays: 29 } });
    expect(preCheck(a, at())).toBe("TENOR_TOO_LONG");
    expect(preCheck(a, at({ receivable: { dueDate: NOW + 29n * DAY, seller: SELLER } }))).toBeUndefined();
  });

  it("skips when the advance exceeds maxAdvanceBps, the receivable is past due or the strategy is not credit", () => {
    const a = strategy("A", ALL, USD(4));
    expect(preCheck(a, at({ advanceBps: 8001 }))).toBe("ADVANCE_TOO_HIGH");
    expect(preCheck(a, at({ receivable: { dueDate: NOW, seller: SELLER } }))).toBe("PAST_DUE");
    expect(preCheck({ ...a, kind: "base" }, at())).toBe("NOT_CREDIT");
    expect(preCheck(a, at({ advanceBps: 8000 }))).toBeUndefined();
  });
});

describe("solve", () => {
  it("checks every strategy concurrently and fills at the seller's rate", async () => {
    const a = strategy("A", ALL, USD(1));
    const b = strategy("B", ALL, USD(1));
    const c = strategy("C", ALL, USD(1));
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
      price: PRICE,
      limit: USD(10),
      facility: "0x00000000000000000000000000000000000000fa" as Address,
      coordinator: "0x00000000000000000000000000000000000000c0" as Address,
      now: NOW,
    });
    expect(peak).toBeGreaterThan(1);
    expect(plan.fills.map((f) => f.aprBps)).toEqual([1100, 1100]);
    expect(plan.fills.map((f) => f.order.maker)).toEqual([c.maker, b.maker]); // equal capacity: input order
    expect(plan.total).toBe(USD(1.5));
  });
});
