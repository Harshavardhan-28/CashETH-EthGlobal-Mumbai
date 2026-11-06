/**
 * Cheapest-first solver: picks the lender fills for `CreditFacility.openAndFund`.
 *
 * Off-chain checks (tenor, advance, balances, allowance, reserve, per-buyer headroom) only prune; the lender's
 * own rules (seller set or seller score, buyer reputation, receivable state) are decided by the credit opcode
 * itself: each strategy's fill is dry-run through `CreditFacility.openAndFund` (an eth_call from the
 * coordinator), so the solver never re-implements the rules and cannot disagree with the chain.
 */
import { AquaRouterAbi, CashEthSwapVMRouterAbi, CreditFacilityAbi } from "@casheth/shared";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { AquaAddresses, Fill, LenderStrategy } from "./types.js";

const DAY = 86_400n;

export type Skipped = { strategyHash: Hex; reason: string };
export type Plan = { fills: Fill[]; total: bigint; skipped: Skipped[] };

/**
 * Skip reasons decided off-chain. On-chain rejections use the custom error name the router reverted with
 * (e.g. `SELLER_NOT_FUNDED_BY_LENDER`, `BuyerReputationTooLow`).
 */
export const SKIP = {
  /** Not a credit strategy. */
  NOT_CREDIT: "NOT_CREDIT",
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
  /** Cheaper strategies already cover the base. */
  NOT_NEEDED: "NOT_NEEDED",
} as const;

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
const clamp0 = (x: bigint): bigint => (x > 0n ? x : 0n);

function virtualUsdc(s: LenderStrategy): bigint {
  return s.virtual[s.tokens[0]] ?? 0n;
}

/** Credit strategies by `aprBps` ascending; ties keep their input order. */
function byPrice(strategies: readonly LenderStrategy[]): LenderStrategy[] {
  return strategies
    .filter((s) => s.kind === "credit" && s.args)
    .map((s, i) => ({ s, i }))
    .sort((x, y) => x.s.args!.aprBps - y.s.args!.aprBps || x.i - y.i)
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
 * Seller, buyer and receivable-state rules are left to the on-chain quote.
 */
export function preCheck(
  s: LenderStrategy,
  p: { receivable: { dueDate: bigint }; advanceBps: number; now: bigint },
): string | undefined {
  if (s.kind !== "credit" || !s.args) return SKIP.NOT_CREDIT;
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
 * Pure greedy plan: credit strategies cheapest first, `take = min(remaining, capacity)` until `base` is
 * covered. `headrooms` maps a strategy hash to its per-buyer headroom (`maxPerBuyer - exposure`); a missing
 * entry means the full `maxPerBuyer`. What a maker has already given in this plan is subtracted from its
 * wallet, allowance and headroom before its next strategy is sized. Base-yield strategies are ignored.
 */
export function planFills(
  strategies: readonly LenderStrategy[],
  headrooms: Readonly<Record<Hex, bigint>>,
  base: bigint,
): Plan {
  const fills: Fill[] = [];
  const skipped: Skipped[] = [];
  const usedByMaker = new Map<string, bigint>();
  let remaining = clamp0(base);
  for (const s of byPrice(strategies)) {
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
    fills.push({ order: s.order, amount: take, aprBps: s.args!.aprBps });
    usedByMaker.set(maker, used + take);
    remaining -= take;
  }
  return { fills, total: clamp0(base) - remaining, skipped };
}

export type SolveInput = {
  receivable: { id: Hex; seller: Address; buyer: Address; amount: bigint; dueDate: bigint };
  strategies: readonly LenderStrategy[];
  advanceBps: number;
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
  // they run concurrently; the results keep price order for the greedy, cheapest-first planner.
  const checks = await Promise.all(byPrice(input.strategies).map((s) => checkStrategy(client, addrs, input, base, s)));
  const skipped: Skipped[] = checks.flatMap((c) => ("skip" in c ? [c.skip] : []));
  const eligible = checks.flatMap((c) => ("headroom" in c ? [c.strategy] : []));
  const headrooms: Record<Hex, bigint> = Object.fromEntries(checks.flatMap((c) => ("headroom" in c ? [[c.strategy.strategyHash, c.headroom]] : [])));

  const plan = planFills(eligible, headrooms, base);
  return { fills: plan.fills, total: plan.total, skipped: [...skipped, ...plan.skipped] };
}

/** One strategy's eligibility: the tier pre-check, its headroom under `maxPerBuyer`, and a dry-run of its fill. */
async function checkStrategy(
  client: Pick<PublicClient, "readContract" | "simulateContract">,
  addrs: Pick<AquaAddresses, "swapRouter">,
  input: SolveInput,
  base: bigint,
  s: LenderStrategy,
): Promise<{ skip: Skipped } | { strategy: LenderStrategy; headroom: bigint }> {
  const { receivable, advanceBps, facility, now } = input;
  const pre = preCheck(s, { receivable, advanceBps, now });
  if (pre) return { skip: { strategyHash: s.strategyHash, reason: pre } };
  const exposure = await client.readContract({
    address: addrs.swapRouter,
    abi: CashEthSwapVMRouterAbi,
    functionName: "exposure",
    args: [s.maker, receivable.buyer],
  });
  const headroom = clamp0(s.args!.maxPerBuyer - exposure);
  // Balance problems are reported by planFills; only dry-run strategies that could give something.
  if (!balanceCheck(s, headroom)) {
    const fill = { order: s.order, amount: min(strategyCapacity(s, headroom), base), aprBps: s.args!.aprBps };
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
