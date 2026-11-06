import { AquaRouterAbi, CreditFacilityAbi, ReceivableRegistryAbi, RepaymentRouterAbi } from "@casheth/shared";
import type { LenderStrategy } from "@casheth/aqua";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { hcsMessage } from "./orchestrator/audit.js";
import { BasicStatsProvider } from "./orchestrator/stats.js";
import { checkTransfer } from "./orchestrator/spend.js";
import type { RawLog } from "./orchestrator/types.js";
import { ADDRS, AQUA_ADDRS, fakeOrchestrator, kyaAgent } from "./test/fakes.js";

const DAY = 86_400;
const T0 = 1_790_000_000;
const seller = getAddress("0x00000000000000000000000000000000000000f1");
const buyer = getAddress("0x00000000000000000000000000000000000000f2");
const worker = getAddress("0x00000000000000000000000000000000000000f3");
const lender = getAddress("0x00000000000000000000000000000000000000f4");
const merchant = getAddress("0x00000000000000000000000000000000000000f5");
const tUsdt = getAddress("0x00000000000000000000000000000000000000f6");
const id = keccak256(toHex("PO-1"));
const spendId = keccak256(toHex("spend"));
const baseHash = keccak256(toHex("base"));
const creditHash = keccak256(toHex("credit"));

/** An encoded log of `eventName` (indexed args in topics, the rest ABI-encoded in data). */
function log(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, timestamp: number, txHash?: Hex): RawLog {
  const event = abi.find((e) => e.type === "event" && e.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as Parameters<typeof encodeEventTopics>[0]) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
  return { address, topics, data, timestamp, txHash: txHash ?? keccak256(toHex(`${eventName}${timestamp}`)) };
}

function strategy(kind: "credit" | "base", hash: Hex): LenderStrategy {
  return {
    kind,
    maker: lender,
    strategyHash: hash,
    order: { maker: lender, traits: 0n, data: "0x" },
    ...(kind === "credit"
      ? { args: { maxTenorDays: 60, maxAdvanceBps: 8000, minBuyerOnTime: 0, maxPerBuyer: 5_000_000n, aprBps: 700, minSellerOnTime: 3, maxSellerDefaults: 0, minReserve: 0n, sellerSet: [] } }
      : { feeBps: 30 }),
    salt: 1n,
    tokens: kind === "credit" ? [ADDRS.usdc, AQUA_ADDRS.rcn] : [ADDRS.usdc, tUsdt],
    virtual: kind === "credit" ? { [ADDRS.usdc]: 1_000_000n } : { [ADDRS.usdc]: 2_000_000n, [tUsdt]: 2_000_000n },
    realUsdc: 5_000_000n,
    allowance: 5_000_000n,
  };
}

const baseShipTx = keccak256(toHex("ship base"));
const creditShipTx = keccak256(toHex("ship credit"));

/** Ships the credit and base strategies (deposits are `Pushed` in the ship transaction), then two base swaps. */
function aquaLogs(): RawLog[] {
  const aqua = AquaRouterAbi as Abi;
  const app = AQUA_ADDRS.swapRouter;
  const shipped = (strategyHash: Hex, tx: Hex) => log(aqua, AQUA_ADDRS.aqua, "Shipped", { maker: lender, app, strategyHash, strategy: "0x1234" }, T0, tx);
  const pushed = (strategyHash: Hex, token: Address, amount: bigint, timestamp: number, tx?: Hex) =>
    log(aqua, AQUA_ADDRS.aqua, "Pushed", { maker: lender, app, strategyHash, token, amount }, timestamp, tx);
  return [
    shipped(creditHash, creditShipTx),
    pushed(creditHash, ADDRS.usdc, 1_000_000n, T0, creditShipTx),
    shipped(baseHash, baseShipTx),
    pushed(baseHash, ADDRS.usdc, 2_000_000n, T0, baseShipTx),
    pushed(baseHash, tUsdt, 2_000_000n, T0, baseShipTx),
    // Two swaps into the base strategy: the taker pushes its input token.
    pushed(baseHash, ADDRS.usdc, 200_000n, T0 + DAY),
    pushed(baseHash, tUsdt, 199_400n, T0 + 2 * DAY),
    // USDC pushed into the credit strategy is not base volume either.
    pushed(creditHash, ADDRS.usdc, 500_000n, T0 + 3 * DAY),
  ];
}

function provider() {
  const o = fakeOrchestrator();
  o.chain.agents.set(seller.toLowerCase(), kyaAgent(2, 1, "s"));
  o.chain.agents.set(lender.toLowerCase(), kyaAgent(2, 4, "l"));
  o.chain.reps.set(seller.toLowerCase(), { onTime: 1, late: 1, defaults: 0 });
  o.chain.balances.set(lender.toLowerCase(), 5_000_000n);
  o.aqua.strategies = [strategy("credit", creditHash), strategy("base", baseHash)];
  o.aqua.addresses = () => ({ ...AQUA_ADDRS, tUsdt });
  const logs: Record<string, RawLog[]> = {
    [ADDRS.receivableRegistry]: [
      log(ReceivableRegistryAbi as Abi, ADDRS.receivableRegistry, "Registered", { id, seller, buyer, amount: 10_000_000n, dueDate: BigInt(T0 + 30 * DAY), detailsCommitment: id }, T0),
      log(ReceivableRegistryAbi as Abi, ADDRS.receivableRegistry, "StateChanged", { id, from: 1, to: 2 }, T0 + 1_000),
      log(ReceivableRegistryAbi as Abi, ADDRS.receivableRegistry, "StateChanged", { id, from: 2, to: 3 }, T0 + 1_000 + 10 * DAY),
    ],
    [ADDRS.creditFacility]: [
      log(CreditFacilityAbi as Abi, ADDRS.creditFacility, "PositionOpened", { id, maker: lender, principal: 4_000_000n, aprBps: 700 }, T0 + 1_000),
      log(CreditFacilityAbi as Abi, ADDRS.creditFacility, "SpendReserved", { id, spendId, worker, merchant, amount: 250_000n, expiry: BigInt(T0 + 2_000) }, T0 + 1_500),
      log(CreditFacilityAbi as Abi, ADDRS.creditFacility, "SpendCommitted", { spendId, hederaTxIdHash: id }, T0 + 1_600),
    ],
    [ADDRS.repaymentRouter]: [log(RepaymentRouterAbi as Abi, ADDRS.repaymentRouter, "LenderPaid", { id, maker: lender, principal: 4_000_000n, fee: 23_013n }, T0 + 1_000 + 10 * DAY)],
    [AQUA_ADDRS.aqua]: aquaLogs(),
  };
  return new BasicStatsProvider({
    chain: o.chain,
    aqua: o.aqua,
    logs: { logs: async (a) => logs[a] ?? [] },
    events: o.events,
    directory: () => [
      { address: seller, label: "seller", role: "seller", uaid: "uaid:aid:seller" },
      { address: worker, label: "workerResearch", role: "worker", uaid: "uaid:aid:worker" },
      { address: lender, label: "lenderA", role: "lender", uaid: "uaid:aid:lender" },
    ],
    now: () => T0 + 36.5 * DAY,
  });
}

describe("BasicStatsProvider", () => {
  it("derives seller stats from registry transitions, reputation and committed spend", async () => {
    const s = await provider().agentStats(seller);
    expect(s).toEqual({
      address: seller,
      uaid: "uaid:aid:seller",
      role: "seller",
      label: "seller",
      level: 2,
      score: 575,
      tier: "medium",
      onTimePct: 50,
      receivablesFunded: 1,
      receivablesRepaid: 1,
      receivablesDefaulted: 0,
      avgDaysToRepay: 10,
      spendByMerchant: { [merchant]: "250000" },
      lenderReturnPct: 0,
    });
  });

  it("attributes committed spend to the worker", async () => {
    expect((await provider().agentStats(worker)).spendByMerchant).toEqual({ [merchant]: "250000" });
  });

  it("computes lender yield: base fees from the base strategy's swap pushes only (no ship deposits), APRs and strategies", async () => {
    const p = provider();
    const y = await p.lenderYield(lender);
    expect(y).toEqual({
      address: lender,
      label: "lenderA",
      tier: "low",
      capital: "5000000",
      lent: "0",
      idle: "5000000",
      // (200_000 + 199_400) x 30 bps; the base and credit ship deposits and the credit push are not fee income.
      baseFees: "1198",
      creditFees: "23013",
      // 1198 / 4_000_000 virtual, annualised over the 35.5 days since the first swap (T0 + 1 day), not the ship time.
      baseApr: 0.31,
      boostApr: 7,
      blendedApr: 0.31,
      strategies: { credit: creditHash, base: baseHash },
    });
    expect((await p.agentStats(lender)).lenderReturnPct).toBe(0.48);
    expect((await p.listLenders()).map((l) => l.address)).toEqual([lender]);
  });
});

describe("co-signer byte check", () => {
  const p = { usdcTokenId: "0.0.429274", spendWalletId: "0.0.100", payTo: "0.0.200", amount: 250_000n };
  const transfer = (over: Partial<{ to: string; from: string; amount: bigint; token: string }> = {}) => ({
    tokenTransfers: [
      { tokenId: over.token ?? p.usdcTokenId, accountId: over.from ?? p.spendWalletId, amount: -(over.amount ?? p.amount) },
      { tokenId: over.token ?? p.usdcTokenId, accountId: over.to ?? p.payTo, amount: over.amount ?? p.amount },
    ],
    hbarTransfers: [],
  });

  it("accepts exactly the reserved payment and refuses anything else", () => {
    expect(checkTransfer(transfer(), p)).toBeUndefined();
    expect(checkTransfer(transfer({ to: "0.0.666" }), p)).toBe("wrong_payee");
    expect(checkTransfer(transfer({ from: "0.0.666" }), p)).toBe("wrong_payer");
    expect(checkTransfer(transfer({ amount: 250_001n }), p)).toBe("amount_mismatch");
    expect(checkTransfer(transfer({ token: "0.0.1" }), p)).toBe("foreign_token_transfer");
    expect(checkTransfer({ ...transfer(), hbarTransfers: [{ accountId: p.spendWalletId, amount: -1n }] }, p)).toBe("hbar_debit");
  });
});

describe("HCS message fitting", () => {
  it("keeps a small message whole and trims derived links, then caller context, from an oversized one", () => {
    const small = { v: 1, type: "Repaid", id: "0x01", hashscan: "https://hashscan.io/testnet/transaction/0x01", seq: 1, prevSeq: 0, ts: "t" };
    expect(hcsMessage(small)).toEqual(small);

    const big = {
      v: 1,
      type: "ReceivableConfirmed",
      id: `0x${"1".repeat(64)}`,
      decision: { approved: false, score: 380, advanceBps: 0, limit: "0", reasons: ["score 380 below 500", "buyer KYA level 2 below 3", "seller KYA level 1 below 2"] },
      hashscan: `https://hashscan.io/testnet/transaction/0x${"2".repeat(64)}`,
      decisionInputs: { buyerReputation: { onTime: 0, late: 3, defaults: 1 }, sellerLevel: 1, buyerLevel: 2, tenorDays: 90 },
      jti: "8ec159ac-8439-4988-9dbf-fe3e5dd2583c",
      agentUaid: `uaid:aid:${"x".repeat(66)};uid=0.0.11337988;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337988`,
      txHash: `0x${"3".repeat(64)}`,
      seller: `0x${"4".repeat(40)}`,
      buyer: `0x${"5".repeat(40)}`,
      extra: "y".repeat(400),
      seq: 2,
      prevSeq: 1,
      ts: "2026-11-06T00:00:00.000Z",
    };
    const out = hcsMessage(big);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(1024);
    expect(out).not.toHaveProperty("hashscan");
    expect(out).toMatchObject({ id: big.id, txHash: big.txHash, decision: big.decision, seq: 2, prevSeq: 1 });
  });
});

describe("BasicStatsProvider freshness", () => {
  it("answers from the last snapshot at once when it is stale and refreshes in the background", async () => {
    const o = fakeOrchestrator();
    let loads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const stats = new BasicStatsProvider({
      chain: o.chain,
      aqua: o.aqua,
      logs: {
        logs: async () => {
          loads++;
          if (loads > 4) await gate; // the second snapshot's log reads hang until released
          return [];
        },
      },
      events: o.events,
      directory: () => [],
      now: () => 1_800_000_000,
      cacheMs: 0,
    });
    await stats.listLenders(); // first snapshot: 4 log reads
    const quick = await Promise.race([stats.listLenders().then(() => "answered"), new Promise((r) => setTimeout(() => r("waited"), 200))]);
    expect(quick).toBe("answered");
    expect(loads).toBeGreaterThan(4); // a refresh started
    release();
  });

  it("reuses the computed agent and lender rows while fresh, so polling clients cause no per-agent chain reads", async () => {
    const o = fakeOrchestrator();
    let chainReads = 0;
    const counted = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A) => (chainReads++, f(...a));
    o.chain.kyaAgent = counted(o.chain.kyaAgent.bind(o.chain));
    o.chain.reputation = counted(o.chain.reputation.bind(o.chain));
    o.chain.usdcBalance = counted(o.chain.usdcBalance.bind(o.chain));
    const stats = new BasicStatsProvider({
      chain: o.chain,
      aqua: o.aqua,
      logs: { logs: async () => [] },
      events: o.events,
      directory: () => [{ address: seller, label: "seller", role: "seller", uaid: "" }, { address: lender, label: "lender", role: "lender", uaid: "" }],
      now: () => 1_800_000_000,
      cacheMs: 60_000,
    });
    await Promise.all([stats.listAgents(), stats.listLenders()]);
    const afterFirst = chainReads;
    for (let i = 0; i < 5; i++) await Promise.all([stats.listAgents(), stats.listLenders()]);
    expect(chainReads).toBe(afterFirst);
  });
});
