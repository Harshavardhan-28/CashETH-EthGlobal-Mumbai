/**
 * The lender yield report behind `scripts/c4-yield.ts`: reads the MCP server's `GET /lenders` and renders the
 * markdown table and the "C4 base yield (scripted volume)" evidence section. The yield math itself lives in the
 * server (`apps/mcp-server/src/orchestrator/stats.ts`); nothing is recomputed here.
 */
import { formatUnits } from "viem";
import type { TradesFile } from "./trader.js";

/** One `GET /lenders` entry: USDC amounts are 6-decimal base-unit strings, APRs are percent numbers. */
export interface LenderYieldRow {
  address: string;
  label: string;
  slabs: string[];
  capital: string;
  lent: string;
  idle: string;
  baseFees: string;
  creditFees: string;
  baseApr: number;
  creditApr: number;
  blendedApr: number;
  extraEarned: string;
  strategies: { credit?: string; base?: string };
}

const usdc = (units: string): string => formatUnits(BigInt(units), 6);
const percent = (value: number): string => `${value}%`;

const DIRECTIONS = { "usdc->tusdt": "USDC -> tUSDT", "tusdt->usdc": "tUSDT -> USDC" } as const;

export async function fetchLenders(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<LenderYieldRow[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/lenders`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return parseLenders(await response.json(), url);
}

const AMOUNT_FIELDS = ["capital", "lent", "idle", "baseFees", "creditFees"] as const;
const PERCENT_FIELDS = ["baseApr", "creditApr", "blendedApr"] as const;

/** Checks the shape the table code relies on, so a server-side rename fails here with the field named. */
function parseLenders(json: unknown, source: string): LenderYieldRow[] {
  if (!Array.isArray(json)) throw new Error(`${source} did not return an array of lender yields`);
  for (const [i, row] of json.entries()) {
    const entry = row as Record<string, unknown> | null;
    const bad = (field: string) => new Error(`${source} lender ${i}: field ${field} is missing or has the wrong type`);
    if (typeof entry?.label !== "string") throw bad("label");
    if (!Array.isArray(entry.slabs)) throw bad("slabs");
    for (const field of AMOUNT_FIELDS) if (typeof entry[field] !== "string" || !/^\d+$/.test(entry[field])) throw bad(field);
    for (const field of PERCENT_FIELDS) if (typeof entry[field] !== "number") throw bad(field);
  }
  return json as LenderYieldRow[];
}

/** Markdown table, one row per lender in label order. */
export function lenderYieldTable(lenders: LenderYieldRow[]): string {
  const header = [
    "| Lender | Slabs | Capital (USDC) | Lent | Idle | Base fees | Credit fees | Farming APR | Lending APR | Blended APR |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const rows = [...lenders]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((l) =>
      [l.label, l.slabs.join(" + ") || "none", usdc(l.capital), usdc(l.lent), usdc(l.idle), usdc(l.baseFees), usdc(l.creditFees), percent(l.baseApr), percent(l.creditApr), percent(l.blendedApr)].join(" | "),
    )
    .map((row) => `| ${row} |`);
  return [...header, ...rows].join("\n");
}

function swapTable(trades: TradesFile["trades"]): string {
  const rows = trades.map(
    (t) => `| ${t.lender} | ${DIRECTIONS[t.direction]} | ${usdc(t.amountIn)} | ${usdc(t.amountOut)} | [${t.txHash}](${t.link}) |`,
  );
  return ["| Lender | Direction | In | Out | Transaction |", "| --- | --- | ---: | ---: | --- |", ...rows].join("\n");
}

/** The `docs/EVIDENCE.md` section: the yield table plus every scripted swap. */
export function formatYieldSection({ date, lenders, trades }: { date: Date; lenders: LenderYieldRow[]; trades: TradesFile }): string {
  return [
    "## C4 base yield (scripted volume)",
    "",
    `Measured ${date.toISOString().slice(0, 10)} from \`GET /lenders\`. Base APR is variable swap-fee income from the volume the scripted trader agent ` +
      "(`agents/src/trader.ts`) pushed through the lenders' base-yield strategies on Hedera testnet; it is not guaranteed. " +
      "Boost APR is the fixed `aprBps` of the lender's credit strategy.",
    "",
    lenderYieldTable(lenders),
    "",
    `Scripted swaps (${trades.trades.length}, \`deployments/testnet/trades.json\`):`,
    "",
    swapTable(trades.trades),
    "",
  ].join("\n");
}
