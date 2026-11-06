/**
 * Integration tests against a local anvil node running the real contracts (AquaRouter, CashEthSwapVMRouter,
 * CashEthOrderBuilder, CreditFacility, registries, RCN). See test/anvil.globalSetup.ts.
 */
import {
  AquaRouterAbi,
  CashEthOrderBuilderAbi,
  CashEthSwapVMRouterAbi,
  CreditFacilityAbi,
  ReceivableRegistryAbi,
} from "@casheth/shared";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  maxUint64,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { account, anvilChain, type Role } from "../test/localStack.js";
import { listOpenStrategies } from "./discover.js";
import {
  buildBaseYieldOrder,
  buildLenderOrder,
  decodeBaseYieldOrder,
  decodeLenderOrder,
  strategyHash,
} from "./orderBuilder.js";
import { dockStrategy, shipBaseYield, shipLenderStrategy, type LenderWallet, type ShippedStrategy } from "./ship.js";
import { solve } from "./solver.js";
import { tierArgs, type AquaAddresses, type CreditArgs } from "./types.js";

const stack = inject("localStack");
const transport = http(stack.rpc);
const pub = createPublicClient({ chain: anvilChain, transport });
const addrs: Required<AquaAddresses> = {
  aqua: stack.aqua,
  swapRouter: stack.swapRouter,
  orderBuilder: stack.orderBuilder,
  usdc: stack.usdc,
  rcn: stack.rcn,
  tUsdt: stack.tUsdt,
};
const wallet = (role: Role): LenderWallet => createWalletClient({ account: account(role), chain: anvilChain, transport });

const USD = (x: number) => BigInt(Math.round(x * 1_000_000));
const WALLET_USDC = USD(100); // LocalStack.s.sol mints 100 USDC to each lender
const seller = account("seller").address;
const worker = account("workerResearch").address;

type Lender = { role: Role; args: CreditArgs; usdc: bigint; salt: bigint; base?: bigint };
const LENDERS: Record<"A" | "B" | "C" | "D", Lender> = {
  A: { role: "lenderA", args: tierArgs("low", { sellerSet: [seller] }), usdc: USD(4), salt: 1n, base: USD(2) },
  B: { role: "lenderB", args: tierArgs("medium", { sellerSet: [seller] }), usdc: USD(2), salt: 2n, base: USD(1) },
  C: { role: "lenderC", args: tierArgs("high"), usdc: USD(3), salt: 3n, base: USD(1) },
  D: { role: "lenderD", args: tierArgs("low", { sellerSet: [worker] }), usdc: USD(1), salt: 4n },
};

const credit = {} as Record<keyof typeof LENDERS, ShippedStrategy>;
const base = {} as Partial<Record<keyof typeof LENDERS, ShippedStrategy>>;
let docked: ShippedStrategy;

beforeAll(async () => {
  // Shipping order A, B, C, D: credit strategies, each lender's base-yield strategy from the same wallet.
  for (const [name, l] of Object.entries(LENDERS) as [keyof typeof LENDERS, Lender][]) {
    const w = wallet(l.role);
    credit[name] = await shipLenderStrategy(w, addrs, { args: l.args, salt: l.salt, usdcAmount: l.usdc });
    if (l.base) {
      base[name] = await shipBaseYield(w, addrs, { usdcAmount: l.base, tUsdtAmount: l.base, feeBps: 30, salt: 100n + l.salt });
    }
  }
  // C ships a second, cheaper credit strategy and docks it again: it must not be discovered.
  const w = wallet("lenderC");
  docked = await shipLenderStrategy(w, addrs, { args: tierArgs("low"), salt: 99n, usdcAmount: USD(1) });
  await dockStrategy(w, addrs.aqua, { app: addrs.swapRouter, strategyHash: docked.strategyHash, tokens: [addrs.usdc, addrs.rcn] });
});

describe("listOpenStrategies", () => {
  it("returns the shipped strategies with kind and tier args", async () => {
    const list = await listOpenStrategies(pub, addrs, { fromBlock: 0n });

    // Credit cheapest first (A and D tie at 700: shipping order), then base yield in shipping order.
    const names = (Object.keys(credit) as (keyof typeof credit)[]).reduce<Record<Hex, string>>((m, k) => {
      m[credit[k].strategyHash] = `credit:${k}`;
      if (base[k]) m[base[k]!.strategyHash] = `base:${k}`;
      return m;
    }, {});
    expect(list.map((s) => names[s.strategyHash] ?? s.strategyHash)).toEqual([
      "credit:A",
      "credit:D",
      "credit:B",
      "credit:C",
      "base:A",
      "base:B",
      "base:C",
    ]);
    expect(list.some((s) => s.strategyHash === docked.strategyHash)).toBe(false);

    for (const s of list) {
      const name = names[s.strategyHash]!.split(":")[1] as keyof typeof LENDERS;
      const l = LENDERS[name];
      const maker = account(l.role).address;
      expect(s.maker).toBe(maker);
      expect(s.order.maker).toBe(maker);
      expect(s.realUsdc).toBe(WALLET_USDC);
      // Exact allowances: the credit amount plus the base-yield amount (plus C's docked strategy), never max.
      const extra = name === "C" ? USD(1) : 0n;
      expect(s.allowance).toBe(l.usdc + (l.base ?? 0n) + extra);
      if (s.kind === "credit") {
        expect(s.args).toEqual(l.args);
        expect(s.feeBps).toBeUndefined();
        expect(s.salt).toBe(l.salt);
        expect(s.tokens).toEqual([addrs.usdc, addrs.rcn]);
        expect(s.virtual).toEqual({ [addrs.usdc]: l.usdc, [addrs.rcn]: 0n });
        expect(s.order).toEqual(credit[name].order);
      } else {
        expect(s.kind).toBe("base");
        expect(s.feeBps).toBe(30);
        expect(s.args).toBeUndefined();
        expect(s.salt).toBe(100n + l.salt);
        expect(s.tokens).toEqual([addrs.usdc, addrs.tUsdt]);
        expect(s.virtual).toEqual({ [addrs.usdc]: l.base, [addrs.tUsdt]: l.base });
      }
    }

    // The tier presets went on-chain unchanged.
    expect(list[0]!.args).toMatchObject({ aprBps: 700, minSellerOnTime: 3, maxPerBuyer: USD(5), sellerSet: [seller] });
    expect(list[3]!.args).toMatchObject({ aprBps: 1300, maxSellerDefaults: 2, sellerSet: [] });

    // The real wallet state behind the numbers.
    const allowanceA = await pub.readContract({
      address: addrs.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account("lenderA").address, addrs.aqua],
    });
    expect(allowanceA).toBe(USD(6));
    const [dockedUsdc] = await pub.readContract({
      address: addrs.aqua,
      abi: AquaRouterAbi,
      functionName: "rawBalances",
      args: [account("lenderC").address, addrs.swapRouter, docked.strategyHash, addrs.usdc],
    });
    expect(dockedUsdc).toBe(0n);
  });
});

describe("order builder", () => {
  it("buildLenderOrder round-trips through decodeLenderOrder", async () => {
    const maker = account("lenderA").address;
    const args: CreditArgs = {
      maxTenorDays: 45,
      maxAdvanceBps: 9000,
      minBuyerOnTime: 3,
      maxPerBuyer: 123_456_789n,
      aprBps: 1300,
      minSellerOnTime: 2,
      maxSellerDefaults: 1,
      minReserve: USD(5),
      sellerSet: [seller, worker],
    };
    const salt = maxUint64 - 5n;
    const { order, strategy } = await buildLenderOrder(pub, addrs.orderBuilder, { maker, rcn: addrs.rcn, usdc: addrs.usdc, args, salt });
    expect(order.maker).toBe(maker);

    const d = await decodeLenderOrder(pub, addrs.orderBuilder, order);
    expect(d.args).toEqual(args);
    expect(d.salt).toBe(salt);
    const [lo, hi] = BigInt(addrs.usdc) < BigInt(addrs.rcn) ? [addrs.usdc, addrs.rcn] : [addrs.rcn, addrs.usdc];
    expect([d.tokenA, d.tokenB]).toEqual([lo, hi]);
    expect(keccak256(strategy)).toBe(await strategyHash(pub, addrs.orderBuilder, order));

    // Base yield round-trips too (fee in basis points), and each decoder rejects the other kind.
    const y = await buildBaseYieldOrder(pub, addrs.orderBuilder, { maker, usdc: addrs.usdc, tUsdt: addrs.tUsdt, feeBps: 30, salt: 7n });
    expect(await decodeBaseYieldOrder(pub, addrs.orderBuilder, y.order)).toMatchObject({ feeBps: 30, salt: 7n });
    // On-chain the fee is in FeeFlatIn's 1e7 units: 30 bps is 30_000.
    const [rawFee] = await pub.readContract({
      address: addrs.orderBuilder,
      abi: CashEthOrderBuilderAbi,
      functionName: "decodeBaseYieldOrder",
      args: [y.order],
    });
    expect(rawFee).toBe(30_000);
    await expect(decodeLenderOrder(pub, addrs.orderBuilder, y.order)).rejects.toThrow(/NotLenderOrder/);
    await expect(decodeBaseYieldOrder(pub, addrs.orderBuilder, order)).rejects.toThrow(/NotBaseYieldOrder/);
  });

  it("strategyHash equals the Shipped event hash", async () => {
    for (const s of [...Object.values(credit), ...Object.values(base)]) {
      const viaBuilder = await strategyHash(pub, addrs.orderBuilder, s!.order);
      expect(viaBuilder).toBe(s!.strategyHash);
      expect(keccak256(s!.strategy)).toBe(s!.strategyHash);
      const viaRouter = await pub.readContract({ address: addrs.swapRouter, abi: CashEthSwapVMRouterAbi, functionName: "hash", args: [s!.order] });
      expect(viaRouter).toBe(s!.strategyHash);
    }
  });
});

describe("solve", () => {
  const receivable = {
    id: stack.receivable.id,
    seller: stack.receivable.seller,
    buyer: stack.receivable.buyer,
    amount: BigInt(stack.receivable.amount),
    dueDate: BigInt(stack.receivable.dueDate),
  };
  const ADVANCE = 7500;
  const LIMIT = USD(6); // 8 USDC * 75%

  async function plan(advanceBps = ADVANCE, limit = LIMIT) {
    const { timestamp } = await pub.getBlock();
    const strategies = await listOpenStrategies(pub, addrs, { fromBlock: 0n });
    return solve(pub, addrs, { receivable, strategies, advanceBps, limit, facility: stack.creditFacility, coordinator: account("coordinator").address, now: timestamp });
  }

  const coordinator = createWalletClient({ account: account("coordinator"), chain: anvilChain, transport });
  const usdcOf = (who: Address) => pub.readContract({ address: addrs.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  async function openAndFund(fills: Awaited<ReturnType<typeof plan>>["fills"], advanceBps: number, limit: bigint) {
    const hash = await coordinator.writeContract({
      address: stack.creditFacility,
      abi: CreditFacilityAbi,
      functionName: "openAndFund",
      args: [receivable.id, fills, advanceBps, limit],
    });
    return (await pub.waitForTransactionReceipt({ hash })).status;
  }

  it("takes A then B and skips C by price and D by SELLER_NOT_FUNDED_BY_LENDER", async () => {
    const p = await plan();
    expect(p.fills).toEqual([
      { order: credit.A.order, amount: USD(4), aprBps: 700 },
      { order: credit.B.order, amount: USD(2), aprBps: 850 },
    ]);
    expect(p.total).toBe(USD(6));
    expect(p.skipped).toEqual([
      { strategyHash: credit.D.strategyHash, reason: "SELLER_NOT_FUNDED_BY_LENDER" },
      { strategyHash: credit.C.strategyHash, reason: "NOT_NEEDED" },
    ]);
  });

  it("skips a strategy the credit opcode rejects, with the decoded error name", async () => {
    // B with a buyer on-time requirement the zero-history buyer cannot meet: only the opcode knows.
    const w = wallet("lenderB");
    const strict = await shipLenderStrategy(w, addrs, {
      args: { ...tierArgs("medium", { sellerSet: [seller] }), aprBps: 600, minBuyerOnTime: 1 },
      salt: 77n,
      usdcAmount: USD(1),
    });
    try {
      const p = await plan();
      expect(p.skipped[0]).toEqual({ strategyHash: strict.strategyHash, reason: "BuyerReputationTooLow" });
      expect(p.fills.map((f) => f.amount)).toEqual([USD(4), USD(2)]);
    } finally {
      await dockStrategy(w, addrs.aqua, { app: addrs.swapRouter, strategyHash: strict.strategyHash, tokens: [addrs.usdc, addrs.rcn] });
    }
  });

  it("never plans more from one lender than its wallet holds across its strategies", async () => {
    // Everything here runs inside an anvil snapshot and is rolled back, so the next test sees the old state.
    const snapshot = await pub.request({ method: "evm_snapshot" as never, params: [] as never });
    try {
      // B keeps 2.2 USDC and ships a second 2 USDC credit strategy: each of B's strategies is backed on its
      // own (2.2 >= 2), together they are not (4 > 2.2).
      const w = wallet("lenderB");
      const b = account("lenderB").address;
      const burn = getAddress("0x000000000000000000000000000000000000dEaD");
      await pub.waitForTransactionReceipt({
        hash: await w.writeContract({ address: addrs.usdc, abi: erc20Abi, functionName: "transfer", args: [burn, WALLET_USDC - USD(2.2)] }),
      });
      const b2 = await shipLenderStrategy(w, addrs, { args: LENDERS.B.args, salt: 5n, usdcAmount: USD(2) });

      // 8 USDC at 8000 bps = 6.4 USDC: A 4, B 2 + 0.2 (B's wallet is spent), C the remaining 0.2.
      const p = await plan(8000, USD(6.4));
      expect(p.fills).toEqual([
        { order: credit.A.order, amount: USD(4), aprBps: 700 },
        { order: credit.B.order, amount: USD(2), aprBps: 850 },
        { order: b2.order, amount: USD(0.2), aprBps: 850 },
        { order: credit.C.order, amount: USD(0.2), aprBps: 1300 },
      ]);
      const fromB = p.fills.filter((f) => f.order.maker === b).reduce((s, f) => s + f.amount, 0n);
      expect(fromB).toBe(await usdcOf(b));

      // And the chain accepts exactly that plan.
      expect(await openAndFund(p.fills, 8000, USD(6.4))).toBe("success");
      expect(await usdcOf(b)).toBe(0n);
      expect(await usdcOf(stack.creditFacility)).toBe(USD(6.4));
    } finally {
      await pub.request({ method: "evm_revert" as never, params: [snapshot] as never });
    }
    expect(await usdcOf(account("lenderB").address)).toBe(WALLET_USDC);
  });

  it("the solver's fills fund the receivable on-chain through openAndFund", async () => {
    const p = await plan();
    expect(await openAndFund(p.fills, ADVANCE, LIMIT)).toBe("success");

    const bal = (token: Address, who: Address) =>
      pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    const a = account("lenderA").address;
    const b = account("lenderB").address;
    const c = account("lenderC").address;
    expect(await bal(addrs.usdc, stack.creditFacility)).toBe(USD(6));
    expect(await bal(addrs.usdc, a)).toBe(WALLET_USDC - USD(4));
    expect(await bal(addrs.usdc, b)).toBe(WALLET_USDC - USD(2));
    expect(await bal(addrs.usdc, c)).toBe(WALLET_USDC);
    expect(await bal(addrs.rcn, a)).toBe(USD(4));
    expect(await bal(addrs.rcn, b)).toBe(USD(2));
    expect(await bal(addrs.rcn, c)).toBe(0n);
    const state = await pub.readContract({ address: stack.receivableRegistry, abi: ReceivableRegistryAbi, functionName: "state", args: [receivable.id] });
    expect(state).toBe(2); // Financed

    // A's credit strategy is spent; its base-yield strategy on the same wallet is untouched.
    const after = await listOpenStrategies(pub, addrs, { fromBlock: 0n });
    const creditA = after.find((s) => s.strategyHash === credit.A.strategyHash)!;
    expect(creditA.virtual).toEqual({ [addrs.usdc]: 0n, [addrs.rcn]: USD(4) });
    expect(creditA.realUsdc).toBe(WALLET_USDC - USD(4));
    const baseA = after.find((s) => s.strategyHash === base.A!.strategyHash)!;
    expect(baseA.virtual).toEqual({ [addrs.usdc]: USD(2), [addrs.tUsdt]: USD(2) });

    // Both schedules went to the MockHSS code installed at 0x16b.
    const n = await pub.readContract({
      address: getAddress("0x000000000000000000000000000000000000016b"),
      abi: parseAbi(["function n() view returns (uint256)"]),
      functionName: "n",
    });
    expect(n).toBe(2n);
  });
});
