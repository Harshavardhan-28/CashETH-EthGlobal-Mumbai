/**
 * C4 base yield (Task 4.6): prints the per-lender yield table from the running MCP read API and appends it, with the
 * scripted swaps' HashScan links, to docs/EVIDENCE.md under "C4 base yield (scripted volume)". It starts nothing.
 *
 *   pnpm -F @casheth/mcp-server dev        (read API on MCP_READ_URL, default http://localhost:4030)
 *   pnpm -F @casheth/agents trader         (writes deployments/testnet/trades.json)
 *   pnpm tsx scripts/c4-yield.ts
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchLenders, formatYieldSection, lenderYieldTable } from "../agents/src/yieldReport.js";
import type { TradesFile } from "../agents/src/trader.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const readUrl = process.env.MCP_READ_URL ?? "http://localhost:4030";
const trades = JSON.parse(readFileSync(`${root}deployments/testnet/trades.json`, "utf8")) as TradesFile;
const lenders = await fetchLenders(readUrl);

console.log(lenderYieldTable(lenders));
appendFileSync(`${root}docs/EVIDENCE.md`, `\n${formatYieldSection({ date: new Date(), lenders, trades })}`);
console.log(`\nAppended "C4 base yield (scripted volume)" to docs/EVIDENCE.md (${trades.trades.length} swaps).`);
