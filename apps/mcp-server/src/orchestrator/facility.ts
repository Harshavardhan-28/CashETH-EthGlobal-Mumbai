/**
 * Credit: lender quotes (Aqua discovery + the cheapest-first solver, no transaction), funding through
 * `CreditFacility.openAndFund` with the coordinator key, and the seller's worker budgets.
 */
import { LENDER_TIERS, type LenderStrategy, type Plan, type Tier } from "@casheth/aqua";
import { CreditFacilityAbi } from "@casheth/shared";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { record } from "./audit.js";
import { actor, addr, bytes32, requireParty, STATE, STATE_NAMES, txLink, units } from "./common.js";
import { fail } from "./errors.js";
import { decisionFor } from "./receivables.js";
import type { Calldata, Caller, Orchestrator } from "./types.js";

export function tierOfApr(aprBps: number): Tier | "custom" {
  const hit = (Object.keys(LENDER_TIERS) as Tier[]).find((t) => LENDER_TIERS[t].aprBps === aprBps);
  return hit ?? "custom";
}

function strategyView(s: LenderStrategy) {
  return {
    maker: s.maker,
    strategyHash: s.strategyHash,
    kind: s.kind,
    ...(s.args ? { aprBps: s.args.aprBps, tier: tierOfApr(s.args.aprBps), sellerSet: s.args.sellerSet } : {}),
    ...(s.feeBps !== undefined ? { feeBps: s.feeBps } : {}),
    virtualUsdc: (s.virtual[s.tokens[0]] ?? 0n).toString(),
    realUsdc: s.realUsdc.toString(),
  };
}

function planView(plan: Plan, strategies: LenderStrategy[]) {
  const hashOf = (order: { maker: Address; data: Hex }) =>
    strategies.find((s) => s.order.maker === order.maker && s.order.data === order.data)?.strategyHash;
  return {
    fills: plan.fills.map((f) => ({ maker: f.order.maker, strategyHash: hashOf(f.order) ?? null, amount: f.amount.toString(), aprBps: f.aprBps })),
    total: plan.total.toString(),
    skipped: plan.skipped,
  };
}

async function planFor(o: Orchestrator, caller: Caller, rawId: string) {
  const id = bytes32(rawId, "id");
  const r = await o.chain.receivable(id);
  if (r.state === STATE.None) fail("NOT_FOUND", `receivable ${id} is not registered`);
  requireParty(caller, r.seller, "seller");
  if (r.state !== STATE.Confirmed) fail("NOT_CONFIRMED", `receivable is ${STATE_NAMES[r.state]}, not Confirmed`, { state: STATE_NAMES[r.state] });
  const { decision } = await decisionFor(o, id);
  const limit = BigInt(decision.limit);
  const [{ strategies }, now] = await Promise.all([o.aqua.discover(), o.chain.latestTimestamp()]);
  const plan = await o.aqua.solve({
    receivable: { id, seller: r.seller, buyer: r.buyer, amount: r.amount, dueDate: r.dueDate },
    strategies,
    advanceBps: decision.advanceBps,
    limit,
    facility: o.chain.addresses().creditFacility,
    now,
  });
  const advance = (r.amount * BigInt(decision.advanceBps)) / 10_000n;
  const base = advance < limit ? advance : limit;
  return { id, r, decision, strategies, plan, base };
}

/** `get_quotes`: open lender strategies and the solver's preview for this receivable (no transaction). */
export async function getQuotes(o: Orchestrator, caller: Caller, input: { id: string }) {
  const { id, decision, strategies, plan, base } = await planFor(o, caller, input.id);
  return {
    id,
    decision,
    borrowingBase: base.toString(),
    strategies: strategies.map(strategyView),
    plan: planView(plan, strategies),
  };
}

/** `open_facility`: solves again and funds with `openAndFund` (coordinator), recording `FacilityFunded`. */
export async function openFacility(o: Orchestrator, caller: Caller, input: { id: string }) {
  const { id, decision, strategies, plan, base } = await planFor(o, caller, input.id);
  if (!decision.approved) fail("CREDIT_DECLINED", "the credit decision declined this receivable", { reasons: decision.reasons });
  if (plan.fills.length === 0) fail("NO_ELIGIBLE_LIQUIDITY", "no lender strategy can fund this receivable", { skipped: plan.skipped });
  const fills = plan.fills.map((f) => ({ order: f.order, amount: f.amount, aprBps: f.aprBps }));
  const { txHash } = await o.chain.send("coordinator", {
    to: o.chain.addresses().creditFacility,
    data: encodeFunctionData({
      abi: CreditFacilityAbi,
      functionName: "openAndFund",
      args: [id, fills, decision.advanceBps, BigInt(decision.limit)],
    }),
    description: "CreditFacility.openAndFund(id, fills, advanceBps, limit)",
  });
  const view = planView(plan, strategies);
  await record(o, {
    type: "FacilityFunded",
    id,
    amount: plan.total.toString(),
    advanceBps: decision.advanceBps,
    makers: plan.fills.map((f) => f.order.maker),
    fills: view.fills.map(({ maker, amount, aprBps }) => ({ maker, amount, aprBps })),
    txHash,
    hashscan: txLink(txHash),
    ...actor(caller),
  });
  return { id, txHash, hashscan: txLink(txHash), funded: plan.total.toString(), borrowingBase: base.toString(), partial: plan.total < base, ...view };
}

export type BudgetInput = { worker: string; alloc: string; maxPerTx: string; maxDaily: string; merchants: string[] };

/**
 * `set_budgets`: `CreditFacility.setBudgets` must be sent by the seller. The server sends it only when it holds
 * the seller's key (`AGENT_KEYS_IN_PROCESS=true`, demo); otherwise it returns the calldata for the seller to sign.
 */
export async function setBudgets(o: Orchestrator, caller: Caller, input: { id: string; budgets: BudgetInput[] }) {
  const id = bytes32(input.id, "id");
  const info = await o.chain.facilityInfo(id);
  if (info.status === 0) fail("FACILITY_NOT_ACTIVE", "the receivable has no facility yet: open_facility first");
  requireParty(caller, info.seller, "seller");
  if (input.budgets.length === 0) fail("BAD_INPUT", "budgets must not be empty");
  const workers = input.budgets.map((b, i) => addr(b.worker, `budgets[${i}].worker`));
  const alloc = input.budgets.map((b, i) => units(b.alloc, `budgets[${i}].alloc`, { allowZero: true }));
  const limits = input.budgets.map((b, i) => ({
    maxPerTx: units(b.maxPerTx, `budgets[${i}].maxPerTx`, { allowZero: true }),
    maxDaily: units(b.maxDaily, `budgets[${i}].maxDaily`, { allowZero: true }),
    merchants: b.merchants.map((m, j) => addr(m, `budgets[${i}].merchants[${j}]`)),
  }));
  const call: Calldata = {
    to: o.chain.addresses().creditFacility,
    data: encodeFunctionData({ abi: CreditFacilityAbi, functionName: "setBudgets", args: [id, workers, alloc, limits] }),
    description: "CreditFacility.setBudgets(id, workers, alloc, limits) from the seller",
  };
  if (!o.chain.holdsKey(info.seller)) return { id, mode: "calldata" as const, calls: [call] };

  const { txHash } = await o.chain.send({ agent: info.seller }, call);
  await record(o, {
    type: "BudgetsSet",
    id,
    workers,
    alloc: alloc.map(String),
    limits: limits.map((l) => ({ maxPerTx: l.maxPerTx.toString(), maxDaily: l.maxDaily.toString(), merchants: l.merchants })),
    txHash,
    hashscan: txLink(txHash),
    ...actor(caller),
  });
  return { id, mode: "sent" as const, txHash, hashscan: txLink(txHash) };
}
