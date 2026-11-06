/** Pure checks and arithmetic behind the demo's assertions; they throw when the run does not match the script. */
import type { LenderStrategy } from "@casheth/aqua";
import { formatUnits, type Address } from "viem";
import type { Quotes } from "../seller.js";
import { EXPECTED_FILLS } from "./plan.js";
import type { AgentStats, AuditEvent, LenderYield } from "./readApi.js";
import type { LenderKey } from "./types.js";

export const formatUsdc = (units: bigint): string => formatUnits(units, 6);

/** Exactly the USDC a lender is short of what it ships; zero when its balance already covers it. */
export function topUpShortfall(balance: bigint, required: bigint): bigint {
  return required > balance ? required - balance : 0n;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface PlannedShip {
  maker: Address;
  seller: Address;
  creditUsdc: bigint;
  aprBps: number;
  /** Only compared when the demo asks for a specific per-buyer cap. */
  maxPerBuyer?: bigint;
}

/**
 * An open credit strategy of `maker` that is what the demo would ship: the planned size, still unspent, at the
 * planned APR and open to the seller. Finding one means a rerun must not ship again.
 */
export function findShippedStrategy(strategies: LenderStrategy[], planned: PlannedShip): LenderStrategy | undefined {
  return strategies.find(
    (s) =>
      s.kind === "credit" &&
      same(s.maker, planned.maker) &&
      s.virtual[s.tokens[0]] === planned.creditUsdc &&
      s.args?.aprBps === planned.aprBps &&
      (planned.maxPerBuyer === undefined || s.args.maxPerBuyer === planned.maxPerBuyer) &&
      s.args.sellerSet.some((seller) => same(seller, planned.seller)),
  );
}

/** The reasons the solver skipped a lender's credit strategies; throws when the lender shipped none. */
function skipReasons(quotes: Quotes, maker: Address, lender: LenderKey): string[] {
  const strategies = quotes.strategies.filter((s) => s.kind === "credit" && same(s.maker, maker));
  if (strategies.length === 0) throw new Error(`lender ${lender} has no credit strategy in the quotes`);
  return strategies.map((s) => {
    const skipped = quotes.plan.skipped.find((k) => k.strategyHash === s.strategyHash);
    if (!skipped) throw new Error(`lender ${lender}'s strategy ${s.strategyHash} was not skipped`);
    return skipped.reason;
  });
}

/** The plan's fills added up per lender, in the order the lenders first appear (a lender may fill from several strategies). */
function fillsByMaker(fills: Quotes["plan"]["fills"]): { maker: Address; amount: bigint }[] {
  const totals: { maker: Address; amount: bigint }[] = [];
  for (const fill of fills) {
    const entry = totals.find((t) => same(t.maker, fill.maker));
    if (entry) entry.amount += BigInt(fill.amount);
    else totals.push({ maker: fill.maker, amount: BigInt(fill.amount) });
  }
  return totals;
}

/**
 * The solver's plan must be the script (`EXPECTED_FILLS` per lender, cheapest first, the last one possibly partial), lender C
 * skipped by price, lender D skipped because the seller is not in its seller set. Returns the one-line summary.
 */
export function checkQuotePlan(quotes: Quotes, makers: Record<LenderKey, Address>): string {
  const { total } = quotes.plan;
  const fills = fillsByMaker(quotes.plan.fills);
  const wanted = EXPECTED_FILLS.map((f) => `${f.lender} ${formatUsdc(f.amount)}`).join(" + ");
  const got = fills.map((f) => `${f.maker} ${formatUsdc(f.amount)}`).join(" + ");
  const matches = fills.length === EXPECTED_FILLS.length && EXPECTED_FILLS.every((e, i) => same(fills[i]!.maker, makers[e.lender]) && fills[i]!.amount === e.amount);
  if (!matches) throw new Error(`expected fills ${wanted}, the plan is ${got || "empty"}`);

  const reasonsC = skipReasons(quotes, makers.C, "C");
  const reasonsD = skipReasons(quotes, makers.D, "D");
  if (!reasonsD.some((r) => r.includes("SELLER_NOT_FUNDED_BY_LENDER"))) {
    throw new Error(`expected lender D skipped with SELLER_NOT_FUNDED_BY_LENDER, got ${reasonsD.join(", ")}`);
  }
  return `fills ${wanted} = ${formatUnits(BigInt(total), 6)}; C skipped (${reasonsC.join(", ")}); D skipped (${reasonsD.join(", ")})`;
}

/**
 * The worker's latest reservation when it is expired and neither committed nor released: it still holds the spend
 * wallet (`WALLET_BUSY`), and the worker may release it. Reads the server's events.
 */
export function expiredReservation(events: AuditEvent[], worker: string, nowSeconds: number): AuditEvent | undefined {
  const reserved = [...events].reverse().find((e) => e.type === "SpendReserved" && e.worker?.toLowerCase() === worker.toLowerCase());
  if (!reserved) return undefined;
  const closed = events.some((e) => (e.type === "SpendCommitted" || e.type === "SpendReleased") && e.spendId === reserved.spendId);
  return !closed && Number(reserved.expiry) <= nowSeconds ? reserved : undefined;
}

/** A plain-text table with left-aligned columns. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function formatLenderTable(lenders: LenderYield[]): string {
  return formatTable(
    ["lender", "tier", "capital", "lent", "idle", "creditFees", "baseFees", "blended APR %"],
    lenders.map((l) => [l.label, l.tier, l.capital, l.lent, l.idle, l.creditFees, l.baseFees, l.blendedApr.toFixed(2)]),
  );
}

export function formatAgentTable(agents: AgentStats[]): string {
  return formatTable(
    ["agent", "role", "level", "score", "tier", "on-time %", "funded", "repaid", "defaulted"],
    agents.map((a) => [a.label, a.role, String(a.level), String(a.score), a.tier, String(a.onTimePct), String(a.receivablesFunded), String(a.receivablesRepaid), String(a.receivablesDefaulted)]),
  );
}
