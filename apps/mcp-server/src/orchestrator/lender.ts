/**
 * Lender tools (plan Addendum A): `fund_agents` ships a credit (boost) strategy for a risk tier, and optionally a
 * base-yield strategy, from the same wallet; `close_strategy` docks one. The lender key signs: the server ships
 * itself only when it holds that key (`LENDER_KEYS_IN_PROCESS=true`, demo), otherwise it returns the calldatas.
 */
import { tierArgs, type CreditArgs, type Tier } from "@casheth/aqua";
import { keccak256, toHex } from "viem";
import { record } from "./audit.js";
import { actor, addr, bytes32, sameAddress, txLink, units } from "./common.js";
import { fail } from "./errors.js";
import { tierOfApr } from "./facility.js";
import type { Caller, FundPlan, Orchestrator } from "./types.js";

export type FundInput = {
  tier?: Tier;
  /** Explicit credit args instead of a tier preset (amounts as base-unit strings). */
  args?: {
    maxTenorDays: number;
    maxAdvanceBps: number;
    minBuyerOnTime: number;
    maxPerBuyer: string;
    aprBps: number;
    minSellerOnTime: number;
    maxSellerDefaults: number;
    minReserve: string;
  };
  sellerSet?: string[];
  maxPerBuyer?: string;
  minReserve?: string;
  creditUsdc: string;
  base?: { usdc: string; tUsdt: string; feeBps?: number };
  idempotencyKey: string;
};

/** uint64 salt derived from the lender and idempotency key, so a retried ship builds the same order. */
function saltOf(lender: string, key: string): bigint {
  return BigInt(keccak256(toHex(`${lender.toLowerCase()}:${key}`))) & 0xffff_ffff_ffff_ffffn;
}

export async function fundAgents(o: Orchestrator, caller: Caller, input: FundInput) {
  const lender = caller.agent;
  const sellerSet = (input.sellerSet ?? []).map((s, i) => addr(s, `sellerSet[${i}]`));
  if (sellerSet.length > 3) fail("BAD_INPUT", "sellerSet holds at most 3 sellers");
  let args: CreditArgs;
  if (input.args && input.tier) fail("BAD_INPUT", "give either tier or args, not both");
  if (input.args) {
    args = {
      ...input.args,
      maxPerBuyer: units(input.args.maxPerBuyer, "args.maxPerBuyer"),
      minReserve: units(input.args.minReserve, "args.minReserve", { allowZero: true }),
      sellerSet,
    };
  } else if (input.tier) {
    args = tierArgs(input.tier, {
      sellerSet,
      ...(input.maxPerBuyer ? { maxPerBuyer: units(input.maxPerBuyer, "maxPerBuyer") } : {}),
      ...(input.minReserve ? { minReserve: units(input.minReserve, "minReserve", { allowZero: true }) } : {}),
    });
  } else {
    fail("BAD_INPUT", "give a tier (low, medium, high) or explicit args");
  }
  const plan: FundPlan = {
    args,
    creditUsdc: units(input.creditUsdc, "creditUsdc"),
    ...(input.base
      ? { base: { usdc: units(input.base.usdc, "base.usdc"), tUsdt: units(input.base.tUsdt, "base.tUsdt"), feeBps: input.base.feeBps ?? 30 } }
      : {}),
    salt: saltOf(lender, input.idempotencyKey),
  };
  const tier = input.tier ?? tierOfApr(args.aprBps);
  const inProcess = o.chain.holdsKey(lender);
  const result = await o.aqua.fund(lender, plan, inProcess);
  if (result.mode === "calldata") {
    return {
      mode: "calldata" as const,
      tier,
      aprBps: args.aprBps,
      calls: result.calls,
      strategies: { credit: result.credit.strategyHash, ...(result.base ? { base: result.base.strategyHash } : {}) },
    };
  }
  await record(o, {
    type: "StrategyShipped",
    kind: "credit",
    maker: lender,
    strategyHash: result.credit.strategyHash,
    tier,
    aprBps: args.aprBps,
    sellerSet,
    amount: plan.creditUsdc.toString(),
    txHash: result.credit.txHash,
    hashscan: txLink(result.credit.txHash),
    ...actor(caller),
  });
  if (result.base && plan.base) {
    await record(o, {
      type: "StrategyShipped",
      kind: "base",
      maker: lender,
      strategyHash: result.base.strategyHash,
      feeBps: plan.base.feeBps,
      amount: plan.base.usdc.toString(),
      tUsdt: plan.base.tUsdt.toString(),
      txHash: result.base.txHash,
      hashscan: txLink(result.base.txHash),
      ...actor(caller),
    });
  }
  return {
    mode: "shipped" as const,
    tier,
    aprBps: args.aprBps,
    credit: { strategyHash: result.credit.strategyHash, txHash: result.credit.txHash, hashscan: txLink(result.credit.txHash) },
    ...(result.base ? { base: { strategyHash: result.base.strategyHash, txHash: result.base.txHash, hashscan: txLink(result.base.txHash) } } : {}),
  };
}

export async function closeStrategy(o: Orchestrator, caller: Caller, input: { strategyHash: string }) {
  const strategyHash = bytes32(input.strategyHash, "strategyHash");
  const { strategies } = await o.aqua.discover();
  const s = strategies.find((x) => x.strategyHash.toLowerCase() === strategyHash && sameAddress(x.maker, caller.agent));
  if (!s) fail("NOT_FOUND", `no open strategy ${strategyHash} of ${caller.agent}`);
  const result = await o.aqua.dock(caller.agent, { strategyHash: s.strategyHash, tokens: s.tokens }, o.chain.holdsKey(caller.agent));
  if (result.mode === "calldata") return { mode: "calldata" as const, strategyHash: s.strategyHash, calls: result.calls };
  await record(o, {
    type: "StrategyDocked",
    kind: s.kind,
    maker: caller.agent,
    strategyHash: s.strategyHash,
    txHash: result.txHash,
    hashscan: txLink(result.txHash),
    ...actor(caller),
  });
  return { mode: "sent" as const, strategyHash: s.strategyHash, txHash: result.txHash, hashscan: txLink(result.txHash) };
}
