/**
 * Solver: picks the lender fills for `CreditFacility.openAndFund`.
 *
 * Every fill pays the seller's own rate (the score and APR the credit opcode computes on chain, `RiskPricing.sol`),
 * so lenders do not compete on price: the solver only finds the strategies that fund the seller's risk slab and
 * takes the largest first, which keeps the number of fills low. Off-chain checks (slab, seller list, tenor,
 * advance, balances, allowance, reserve, per-buyer headroom) only prune; the chain decides: each strategy's fill
 * is dry-run through `CreditFacility.openAndFund` (an eth_call from the coordinator), so the solver cannot
 * disagree with the opcode.
 */
import { limitConcurrency, RELAY_CONCURRENCY, retryEmptyResult } from "./relayRead.js";
import { AquaRouterAbi, CashEthSwapVMRouterAbi, CreditFacilityAbi } from "@casheth/shared";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { slabsOf, type AquaAddresses, type Fill, type LenderStrategy, type RiskSlab } from "./types.js";

const DAY = 86_400n;

export type Skipped = { strategyHash: Hex; reason: string };
export type Plan = { fills: Fill[]; total: bigint; skipped: Skipped[] };

/**
 * Skip reasons decided off-chain. On-chain rejections use the custom error name the router reverted with
 * (e.g. `SELLER_NOT_FUNDED_BY_LENDER`, `SlabNotFunded`).
 */
export const SKIP = {
  /** Not a credit strategy. */
  NOT_CREDIT: "NOT_CREDIT",
  /** The strategy does not fund the seller's risk slab. */
  SLAB_NOT_FUNDED: "SLAB_NOT_FUNDED",
  /** The strategy funds a list of sellers that leaves this one out. */
  SELLER_NOT_LISTED: "SELLER_NOT_LISTED",
  /** The receivable is due now or earlier. */
  PAST_DUE: "PAST_DUE",
  TENOR_TOO_LONG: "TENOR_TOO_LONG",
  ADVANCE_TOO_HIGH: "ADVANCE_TOO_HIGH",
  /** Nothing shipped (or everything already advanced). */
  NO_VIRTUAL_BALANCE: "NO_VIRTUAL_BALANCE",
  /** The wallet holds less USDC than the strategy shipped: an over-committed lender is skipped whole. */
  UNDERFUNDED: "UNDERFUNDED",
  /** Allowance, reserve or per-buyer cap leave nothing to take. */
  NO_CAPACITY: "NO_CAPACITY",
  /** Larger strategies already cover the base. */
  NOT_NEEDED: "NOT_NEEDED",
} as const;

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
const clamp0 = (x: bigint): bigint => (x > 0n ? x : 0n);

function virtualUsdc(s: LenderStrategy): bigint {
  return s.virtual[s.tokens[0]] ?? 0n;
}

function creditOnly(strategies: readonly LenderStrategy[]): LenderStrategy[] {
  return strategies.filter((s) => s.kind === "credit" && s.args);
}

/** Credit strategies by what they can give on their own, largest first; ties keep their input order. */
function byCapacity(strategies: readonly LenderStrategy[], headrooms: Readonly<Record<Hex, bigint>>): LenderStrategy[] {
  const capacity = (s: LenderStrategy) => strategyCapacity(s, headrooms[s.strategyHash] ?? s.args!.maxPerBuyer);
  return creditOnly(strategies)
    .map((s, i) => ({ s, i, c: capacity(s) }))
    .sort((x, y) => (x.c === y.c ? x.i - y.i : x.c > y.c ? -1 : 1))
    .map(({ s }) => s);
}

/**
 * Most USDC `s` can advance: `min(virtual USDC, allowance - used, headroom - used, realUsdc - used - minReserve)`,
 * where `headroom` is `maxPerBuyer - exposure(maker, buyer)` and `used` is what earlier fills of the same plan
 * already take from the same maker. Wallet balance, allowance to Aqua and the per-buyer exposure belong to the
 * maker, not the strategy, so every strategy of one maker draws on the same three budgets (the opcode checks
 * `exposure[maker][buyer]` and the maker's wallet on each fill). Real USDC is not a cap by itself: `planFills`
 * skips strategies whose wallet is below their virtual balance.
 */
export function strategyCapacity(s: LenderStrategy, headroom: bigint, used = 0n): bigint {
  const reserve = s.args?.minReserve ?? 0n;
  return clamp0(min(virtualUsdc(s), s.allowance - used, headroom - used, s.realUsdc - used - reserve));
}

/**
 * Off-chain eligibility of one strategy for a receivable; returns the skip reason or `undefined`.
 * The seller's score and the receivable's state are left to the on-chain dry run.
 */
export function preCheck(
  s: LenderStrategy,
  p: { receivable: { dueDate: bigint; seller: Address }; advanceBps: number; now: bigint; slab: RiskSlab },
): string | undefined {
  if (s.kind !== "credit" || !s.args) return SKIP.NOT_CREDIT;
  if (!slabsOf(s.args.slabMask).includes(p.slab)) return SKIP.SLAB_NOT_FUNDED;
  const listed = s.args.sellerSet;
  if (listed.length > 0 && !listed.some((a) => a.toLowerCase() === p.receivable.seller.toLowerCase())) return SKIP.SELLER_NOT_LISTED;
  if (p.receivable.dueDate <= p.now) return SKIP.PAST_DUE;
  if (p.receivable.dueDate - p.now > BigInt(s.args.maxTenorDays) * DAY) return SKIP.TENOR_TOO_LONG;
  if (p.advanceBps > s.args.maxAdvanceBps) return SKIP.ADVANCE_TOO_HIGH;
  return undefined;
}

/** Skip reason from balances alone, or `undefined` when the strategy has something to give. */
function balanceCheck(s: LenderStrategy, headroom: bigint, used = 0n): string | undefined {
  const shipped = virtualUsdc(s);
  if (shipped === 0n) return SKIP.NO_VIRTUAL_BALANCE;
  if (s.realUsdc < shipped) return SKIP.UNDERFUNDED;
  if (strategyCapacity(s, headroom, used) === 0n) return SKIP.NO_CAPACITY;
  return undefined;
}

/**
 * Pure greedy plan at the seller's rate `aprBps`: credit strategies largest capacity first,
 * `take = min(remaining, capacity)` until `base` is covered. `headrooms` maps a strategy hash to its per-buyer
 * headroom (`maxPerBuyer - exposure`); a missing entry means the full `maxPerBuyer`. What a maker has already
 * given in this plan is subtracted from its wallet, allowance and headroom before its next strategy is sized.
 * Base-yield strategies are ignored.
 */
export function planFills(
  strategies: readonly LenderStrategy[],
  headrooms: Readonly<Record<Hex, bigint>>,
  base: bigint,
  aprBps: number,
): Plan {
  const fills: Fill[] = [];
  const skipped: Skipped[] = [];
  const usedByMaker = new Map<string, bigint>();
  let remaining = clamp0(base);
  for (const s of byCapacity(strategies, headrooms)) {
    const headroom = headrooms[s.strategyHash] ?? s.args!.maxPerBuyer;
    if (remaining === 0n) {
      skipped.push({ strategyHash: s.strategyHash, reason: SKIP.NOT_NEEDED });
      continue;
    }
    const maker = s.maker.toLowerCase();
    const used = usedByMaker.get(maker) ?? 0n;
    const reason = balanceCheck(s, headroom, used);
    if (reason) {
      skipped.push({ strategyHash: s.strategyHash, reason });
      continue;
    }
    const take = min(remaining, strategyCapacity(s, headroom, used));
    fills.push({ order: s.order, amount: take, aprBps });
    usedByMaker.set(maker, used + take);
    remaining -= take;
  }
  return { fills, total: clamp0(base) - remaining, skipped };
}

export type SolveInput = {
  receivable: { id: Hex; seller: Address; buyer: Address; amount: bigint; dueDate: bigint };
  strategies: readonly LenderStrategy[];
  advanceBps: number;
  /** The seller's slab and rate from the engine (`scoreReceivable`); the opcode recomputes and enforces both. */
  price: { slab: RiskSlab; aprBps: number };
  /** The engine's limit (USDC base units); the plan covers `min(amount * advanceBps / 10_000, limit)`. */
  limit: bigint;
  facility: Address;
  /** The account allowed to call `openAndFund`: the dry runs are sent from it. */
  coordinator: Address;
  /** Unix seconds (use the chain's latest block timestamp). */
  now: bigint;
};

/** `openAndFund` plus every custom error it can bubble up from the facility, the router and Aqua. */
const SIMULATION_ABI = [
  ...CreditFacilityAbi,
  ...[...CashEthSwapVMRouterAbi, ...AquaRouterAbi].filter(
    (e, i, all) =>
      e.type === "error" &&
      !CreditFacilityAbi.some((f) => f.type === "error" && f.name === e.name) &&
      all.findIndex((x) => x.type === "error" && x.name === e.name) === i,
  ),
] as Abi;

/** The custom error name a failed call reverted with, or a generic label. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.signature ?? reverted.reason ?? "REVERTED";
    }
  }
  throw err;
}

/**
 * Plans the fills for one receivable: pre-checks each credit strategy, reads the maker's on-chain exposure to
 * the buyer, dry-runs a fill of the strategy's capacity (at most the base) through `openAndFund` from the
 * coordinator (any revert skips the strategy with the decoded error name), then runs `planFills` on the
 * survivors, which shares each maker's wallet, allowance and per-buyer headroom across all of that maker's
 * strategies.
 *
 * Why not `router.quote` from the facility: the opcode only accepts the facility as taker, and Hedera's
 * eth_call ignores a contract `from` (the taker reads as 0x...02). The coordinator is an ordinary account, so
 * the facility's real entry point can be simulated from it on every chain.
 *
 * The plan can be empty (no eligible liquidity): never send an empty `fills` to `openAndFund`, it reverts
 * `NOT_CHEAPEST_FIRST`. A `total` below the base is a partial plan the caller may accept or decline.
 */
export async function solve(
  client: Pick<PublicClient, "readContract" | "simulateContract">,
  addrs: Pick<AquaAddresses, "swapRouter">,
  input: SolveInput,
): Promise<Plan> {
  const advance = (input.receivable.amount * BigInt(input.advanceBps)) / 10_000n;
  const base = min(advance, input.limit);

  // Each strategy's check (its buyer exposure, then a dry-run of its own fill) is independent of the others, so
  // they run a few at a time; the planner then orders the survivors by capacity.
  const checks = await limitConcurrency(creditOnly(input.strategies), RELAY_CONCURRENCY, (s) => checkStrategy(client, addrs, input, base, s));
  const skipped: Skipped[] = checks.flatMap((c) => ("skip" in c ? [c.skip] : []));
  const eligible = checks.flatMap((c) => ("headroom" in c ? [c.strategy] : []));
  const headrooms: Record<Hex, bigint> = Object.fromEntries(checks.flatMap((c) => ("headroom" in c ? [[c.strategy.strategyHash, c.headroom]] : [])));

  const plan = planFills(eligible, headrooms, base, input.price.aprBps);
  return { fills: plan.fills, total: plan.total, skipped: [...skipped, ...plan.skipped] };
}

/** One strategy's eligibility: the pre-check, its headroom under `maxPerBuyer`, and a dry-run of its fill. */
async function checkStrategy(
  client: Pick<PublicClient, "readContract" | "simulateContract">,
  addrs: Pick<AquaAddresses, "swapRouter">,
  input: SolveInput,
  base: bigint,
  s: LenderStrategy,
): Promise<{ skip: Skipped } | { strategy: LenderStrategy; headroom: bigint }> {
  const { receivable, advanceBps, facility, now, price } = input;
  const pre = preCheck(s, { receivable, advanceBps, now, slab: price.slab });
  if (pre) return { skip: { strategyHash: s.strategyHash, reason: pre } };
  const exposure = await retryEmptyResult(() =>
    client.readContract({ address: addrs.swapRouter, abi: CashEthSwapVMRouterAbi, functionName: "exposure", args: [s.maker, receivable.buyer] }),
  );
  const headroom = clamp0(s.args!.maxPerBuyer - exposure);
  // Balance problems are reported by planFills; only dry-run strategies that could give something.
  if (!balanceCheck(s, headroom)) {
    const fill = { order: s.order, amount: min(strategyCapacity(s, headroom), base), aprBps: price.aprBps };
    try {
      await client.simulateContract({
        address: facility,
        abi: SIMULATION_ABI,
        functionName: "openAndFund",
        args: [receivable.id, [fill], advanceBps, input.limit],
        account: input.coordinator,
      });
    } catch (err) {
      return { skip: { strategyHash: s.strategyHash, reason: revertReason(err) } };
    }
  }
  return { strategy: s, headroom };
}
