/**
 * C4 (Task 4.5L): the first Aqua-funded facility on Hedera testnet. PO-1002 (registered by
 * scripts/c4-register.ts, strategies shipped by scripts/c4-ship-strategies.ts) is scored, the solver picks
 * the lender fills and the coordinator sends `CreditFacility.openAndFund`.
 *
 *   pnpm -r build && pnpm tsx scripts/c4-open-facility.ts
 *
 * Steps (the funding is skipped when `deployments/testnet/facility.json` has it, the rest are re-checked):
 *   1. fund   - `scoreReceivable`, `solve` over the open strategies, then `openAndFund(id, fills, advanceBps,
 *               limit)` from the coordinator.
 *   2. verify - facility USDC balance, each filled lender's RCN, registry state Financed, the `FacilityFunded`,
 *               `PositionOpened` and `Scheduled` events, and that the transaction created exactly one schedule
 *               entity (markOverdue; Hedera allows one `scheduleCall` per transaction, `markOverdue` schedules
 *               the default check later) and that it is pending on the mirror node.
 *   3. revert - `openAndFund` for an unregistered id (NOT_CONFIRMED) and from the seller (NOT_COORDINATOR):
 *               real transactions whose revert data is read back from the mirror node.
 *   4. audit  - `FacilityFunded` (id, fills, total) on the HCS audit topic.
 */
import { existsSync } from "node:fs";
import { listOpenStrategies, solve, type Plan } from "@casheth/aqua";
import { scoreReceivable, type Decision } from "@casheth/engine";
import { contracts, hieroClient, mirror, resolveContractId } from "@casheth/hedera";
import { CreditFacilityAbi, loadHederaIds } from "@casheth/shared";
import { decodeFunctionData, erc20Abi, keccak256, parseEventLogs, toHex, zeroAddress, type Address, type Hex } from "viem";
import type { Rejection, Step } from "./c4-state.js";
import { accountEvm, loadDeployment, proveRevert, publishAuditOnce, walletFor } from "./lib/c4.js";
import { env, mirrorGet, pub, readJson, ROOT, send, writeJson } from "./spikes/lib.js";

const FACILITY_FILE = `${ROOT}deployments/testnet/facility.json`;
const FINANCED = 2;

type FillRecord = { maker: Address; lender: string; amount: string; aprBps: number };
type SkipRecord = { strategyHash: Hex; lender: string; kind: string; reason: string };
type FacilityRecord = {
  receivableId: Hex;
  decision: { score: number; advanceBps: number; limit: string };
  plan: { fills: FillRecord[]; total: string; skipped: SkipRecord[] };
  fund: Step;
  verified?: Record<string, string>;
  reverts?: { unregistered: Rejection; notCoordinator: Rejection };
  audit?: { seq: number; txId: string; hashscan: string; prevSeq: number };
};

const deployment = loadDeployment();
const { aqua, creditFacility: facility } = deployment;
const { registration } = readJson<{ registration: { receivableId: Hex } }>(`${ROOT}deployments/testnet/c4.json`);
const receivableId = registration.receivableId;
const { hcsAuditTopicId: topicId } = loadHederaIds();
const { registry, kya } = contracts(env, { addresses: deployment.addresses });
const coordinator = walletFor("COORDINATOR");

/** Which lender and strategy kind each shipped strategy hash and each maker belongs to. */
const shipped = readJson<{ strategies: { lender: string; kind: string; maker: Address; strategyHash: Hex }[] }>(
  `${ROOT}deployments/testnet/strategies.json`,
).strategies;
const lenderOfMaker = (maker: Address): string => shipped.find((s) => s.maker === maker)?.lender ?? maker;
const strategyOf = (hash: Hex) => shipped.find((s) => s.strategyHash === hash);

// ------------------------------------------------------------------ 1. fund

async function decideAndPlan(): Promise<{ decision: Decision; plan: Plan }> {
  const r = await registry.read.get([receivableId]);
  const [reputation, buyerLevel, sellerLevel, block, strategies] = await Promise.all([
    kya.read.reputation([r.seller]),
    kya.read.level([r.buyer]),
    kya.read.level([r.seller]),
    pub.getBlock(),
    listOpenStrategies(pub, aqua, { fromBlock: deployment.fromBlock }),
  ]);
  const dueDate = BigInt(r.dueDate);
  const decision = scoreReceivable({
    amount: r.amount,
    dueDate,
    now: block.timestamp,
    sellerReputation: { onTime: reputation[0], late: reputation[1], defaults: reputation[2] },
    sellerLevel,
    buyerLevel,
  });
  if (!decision.approved) throw new Error(`engine declined ${receivableId}: ${decision.reasons.join("; ")}`);
  console.log(`  score ${decision.score} (${decision.slab} risk, ${decision.aprBps} bps): advance ${decision.advanceBps} bps, limit ${decision.limit} USDC units`);
  if (decision.slab === "none") throw new Error(`score ${decision.score} is not financeable`);

  const plan = await solve(pub, aqua, {
    receivable: { id: receivableId, seller: r.seller, buyer: r.buyer, amount: r.amount, dueDate },
    strategies,
    advanceBps: decision.advanceBps,
    price: { slab: decision.slab, aprBps: decision.aprBps },
    limit: decision.limit,
    facility,
    coordinator: accountEvm("COORDINATOR"),
    now: block.timestamp,
  });
  return { decision, plan };
}

function recordPlan(plan: Plan): FacilityRecord["plan"] {
  return {
    fills: plan.fills.map((f) => ({
      maker: f.order.maker,
      lender: lenderOfMaker(f.order.maker),
      amount: f.amount.toString(),
      aprBps: f.aprBps,
    })),
    total: plan.total.toString(),
    skipped: plan.skipped.map((s) => ({
      strategyHash: s.strategyHash,
      lender: strategyOf(s.strategyHash)?.lender ?? "?",
      kind: strategyOf(s.strategyHash)?.kind ?? "?",
      reason: s.reason,
    })),
  };
}

async function fund(): Promise<FacilityRecord> {
  console.log("1. fund: score, solve, openAndFund from the coordinator");
  const state = await registry.read.state([receivableId]);
  if (state !== 1) throw new Error(`receivable ${receivableId} is in state ${state}, not Confirmed, and facility.json has no funding`);
  const { decision, plan } = await decideAndPlan();
  const summary = recordPlan(plan);
  for (const f of summary.fills) console.log(`  fill  lender ${f.lender}: ${f.amount} units at ${f.aprBps} bps`);
  for (const s of summary.skipped) console.log(`  skip  lender ${s.lender} ${s.kind}: ${s.reason}`);
  // A partial plan is fine (the facility only caps the total); an empty one would revert NOT_CHEAPEST_FIRST.
  if (plan.fills.length === 0) throw new Error("the solver found no eligible liquidity");

  const fundTx = await send(
    `CreditFacility.openAndFund(PO-1002, ${plan.fills.length} fills)`,
    {
      address: facility,
      abi: CreditFacilityAbi,
      functionName: "openAndFund",
      args: [receivableId, plan.fills, decision.advanceBps, decision.limit],
    },
    coordinator,
  );
  return {
    receivableId,
    decision: { score: decision.score, advanceBps: decision.advanceBps, limit: decision.limit.toString() },
    plan: summary,
    fund: fundTx,
  };
}

// ------------------------------------------------------------------ 2. verify

const usdcBalance = (who: Address) =>
  pub.readContract({ address: aqua.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const rcnBalance = (who: Address) =>
  pub.readContract({ address: aqua.rcn, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/** Schedule entity ids are the long-zero form of the schedule's EVM address. */
const scheduleId = (schedule: Address): string => `0.0.${BigInt(schedule)}`;

/** The schedule entities a transaction created, from its child records on the mirror node. */
async function createdSchedules(transactionId: string): Promise<string[]> {
  const mirrorId = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const { transactions } = await mirror.waitFor(() =>
    mirrorGet<{ transactions: { name: string; entity_id: string | null }[] }>(`/transactions/${mirrorId}`),
  );
  return transactions.filter((t) => t.name === "SCHEDULECREATE").map((t) => t.entity_id ?? "?");
}

async function checkSchedule(record: FacilityRecord, overdue: Address, defaulted: Address): Promise<Record<string, string>> {
  if (overdue === zeroAddress) throw new Error("the markOverdue schedule is the zero address");
  if (defaulted !== zeroAddress) throw new Error(`the funding scheduled markDefaulted (${defaulted}); markOverdue must do that`);
  const id = scheduleId(overdue);
  const created = await createdSchedules(record.fund.transactionId);
  if (created.length !== 1 || created[0] !== id) throw new Error(`funding created schedules [${created.join(", ")}], expected only ${id}`);
  const s = await mirror.waitFor(() =>
    mirrorGet<{ deleted: boolean; executed_timestamp: string | null; expiration_time: string | null }>(`/schedules/${id}`),
  );
  if (s.deleted || s.executed_timestamp) throw new Error(`schedule ${id} (markOverdue) is deleted or already executed`);
  return { "schedule markOverdue (the only one created)": `${id} expires ${s.expiration_time}` };
}

async function verify(record: FacilityRecord): Promise<Record<string, string>> {
  console.log("2. verify: balances, registry state, events, schedules");
  const total = BigInt(record.plan.total);
  const receipt = await pub.getTransactionReceipt({ hash: record.fund.hash });
  const events = parseEventLogs({ abi: CreditFacilityAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === facility.toLowerCase()) });
  const named = <N extends string>(name: N) => events.filter((e) => e.eventName === name);

  const funded = named("FacilityFunded")[0]?.args as { id: Hex; funded: bigint; advanceBps: number; makers: Address[] } | undefined;
  if (!funded || funded.id !== receivableId || funded.funded !== total) throw new Error(`FacilityFunded does not match: ${JSON.stringify(funded, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  if (named("ScheduleSkipped").length > 0) throw new Error("the facility emitted ScheduleSkipped");
  const scheduled = named("Scheduled")[0]?.args as { overdueSchedule: Address; defaultSchedule: Address } | undefined;
  if (!scheduled) throw new Error("no Scheduled event");

  const [facilityUsdc, state, contractId] = await Promise.all([
    usdcBalance(facility),
    registry.read.state([receivableId]),
    resolveContractId(env, facility),
  ]);
  const mirrorUsdc = await mirror.tokenBalance(env, contractId, env.USDC_TOKEN_ID);
  if (facilityUsdc !== total || mirrorUsdc !== total) throw new Error(`facility holds ${facilityUsdc} (mirror ${mirrorUsdc}), expected ${total}`);
  if (state !== FINANCED) throw new Error(`registry state ${state}, expected Financed (${FINANCED})`);

  const verified: Record<string, string> = {
    "facility USDC (eth_call = mirror)": `${facilityUsdc} units`,
    "registry state": `${state} (Financed)`,
    FacilityFunded: `funded ${funded.funded}, advanceBps ${funded.advanceBps}, makers ${funded.makers.map(lenderOfMaker).join("+")}`,
  };
  for (const f of record.plan.fills) {
    const rcn = await rcnBalance(f.maker);
    if (rcn !== BigInt(f.amount)) throw new Error(`lender ${f.lender} holds ${rcn} RCN, expected ${f.amount}`);
    verified[`lender ${f.lender} RCN`] = `${rcn} units`;
  }
  const opened = named("PositionOpened").length;
  if (opened !== record.plan.fills.length) throw new Error(`${opened} PositionOpened events for ${record.plan.fills.length} fills`);
  verified.PositionOpened = `${opened} events`;
  Object.assign(verified, await checkSchedule(record, scheduled.overdueSchedule, scheduled.defaultSchedule));
  for (const [k, v] of Object.entries(verified)) console.log(`  ${k}: ${v}`);
  return verified;
}

// ------------------------------------------------------------------ 3. reverts

/** The `openAndFund` arguments of the real funding transaction, decoded from its calldata. */
async function fundingArgs(record: FacilityRecord): Promise<readonly [Hex, unknown, number, bigint]> {
  const { input } = await pub.getTransaction({ hash: record.fund.hash });
  return decodeFunctionData({ abi: CreditFacilityAbi, data: input }).args as readonly [Hex, unknown, number, bigint];
}

async function proveReverts(record: FacilityRecord): Promise<NonNullable<FacilityRecord["reverts"]>> {
  console.log("3. revert: unregistered id, and from the seller");
  const [, fills, advanceBps, limit] = await fundingArgs(record);
  const openAndFund = (id: Hex) => ({
    address: facility,
    abi: CreditFacilityAbi,
    functionName: "openAndFund",
    args: [id, fills, advanceBps, limit],
  });
  const unregistered = await proveRevert(
    coordinator,
    openAndFund(keccak256(toHex("PO-9999-unregistered"))),
    "NOT_CONFIRMED",
    "openAndFund(unregistered id) from the coordinator",
  );
  const notCoordinator = await proveRevert(
    walletFor("SELLER"),
    openAndFund(receivableId),
    "NOT_COORDINATOR",
    "openAndFund(PO-1002) from the seller",
  );
  return { unregistered, notCoordinator };
}

// ------------------------------------------------------------------ 4. audit

async function publishFunded(record: FacilityRecord): Promise<NonNullable<FacilityRecord["audit"]>> {
  const client = hieroClient(env);
  try {
    return await publishAuditOnce(client, topicId, "FacilityFunded", receivableId, {
      amount: record.plan.total,
      asset: "USDC",
      txId: record.fund.transactionId,
      advanceBps: record.decision.advanceBps,
      fills: record.plan.fills.map(({ maker, amount, aprBps }) => ({ maker, amount, aprBps })),
    });
  } finally {
    client.close();
  }
}

// ------------------------------------------------------------------ main

const record = existsSync(FACILITY_FILE) ? readJson<FacilityRecord>(FACILITY_FILE) : await fund();
writeJson(FACILITY_FILE, record);
console.log(`  openAndFund: ${record.fund.hashscan}`);

record.verified = await verify(record);
writeJson(FACILITY_FILE, record);

record.reverts ??= await proveReverts(record);
writeJson(FACILITY_FILE, record);

console.log("4. audit: FacilityFunded on the HCS topic");
record.audit ??= await publishFunded(record);
writeJson(FACILITY_FILE, record);
