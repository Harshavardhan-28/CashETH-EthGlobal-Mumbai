/**
 * Checks every HashScan link in docs/EVIDENCE.md and README.md against the Hedera testnet mirror node.
 *
 *   pnpm verify:evidence
 *
 * - transactions must exist and report their expected result: SUCCESS, or the failure the text claims
 *   (CONTRACT_REVERT_EXECUTED for the revert proofs, a named HAPI status where the text names one);
 * - contracts must exist with runtime bytecode; accounts, topics, tokens and schedules must exist.
 * Links in archived or first-deployment sections are still queried but their failures do not change the exit code.
 * TODO and "pending demo run" markers are listed as pending and never fail the run.
 *
 * Prints a markdown table; exits 1 if any non-archived link fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dedupeLinks, mirrorPath, parseEvidence, type DistinctLink, type PendingMarker } from "./lib/evidence.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIRROR = process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com";
const FILES = ["docs/EVIDENCE.md", "README.md"];
/** At most 5 requests per second. */
const MIN_INTERVAL_MS = 220;
const MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  lastRequestAt = Date.now() + Math.max(wait, 0);
  if (wait > 0) await sleep(wait);
}

/** GET with a polite rate limit; retries 429, 5xx and network errors with exponential backoff. */
async function getJson(path: string): Promise<{ status: number; body: any }> {
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throttle();
    try {
      const res = await fetch(`${MIRROR}/api/v1${path}`, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    } catch (error) {
      lastError = (error as Error).message;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`mirror node unavailable after ${MAX_ATTEMPTS} attempts (${lastError})`);
}

interface Row {
  link: DistinctLink;
  /** What the mirror node reported, e.g. `SUCCESS` or `runtime 23759 B`. */
  mirror: string;
  ok: boolean;
}

async function checkLink(link: DistinctLink): Promise<Pick<Row, "mirror" | "ok">> {
  const { status, body } = await getJson(mirrorPath(link));
  if (status === 404) return { mirror: "not found (404)", ok: false };
  if (status !== 200 || !body) return { mirror: `HTTP ${status}`, ok: false };

  switch (link.kind) {
    case "transaction": {
      const txs: { result: string; nonce: number; scheduled?: boolean }[] = body.transactions ?? [];
      // A contract call also lists child transactions (HTS transfers, scheduled records); the user transaction is nonce 0.
      const tx = txs.find((t) => t.nonce === 0 && !t.scheduled) ?? txs[0];
      if (!tx) return { mirror: "no transaction record", ok: false };
      const { expect } = link;
      const ok =
        expect.type === "success"
          ? tx.result === "SUCCESS"
          : expect.status
            ? tx.result === expect.status
            : tx.result !== "SUCCESS";
      return { mirror: tx.result, ok };
    }
    case "contract": {
      const bytecode: string | null = body.runtime_bytecode ?? null;
      const bytes = bytecode && bytecode !== "0x" ? (bytecode.length - 2) / 2 : 0;
      return { mirror: bytes > 0 ? `runtime ${bytes} B` : "no runtime bytecode", ok: bytes > 0 };
    }
    case "account":
      return { mirror: `exists (${body.account})`, ok: Boolean(body.account) };
    case "topic": {
      const count = (body.messages ?? []).length;
      return { mirror: count > 0 ? "has messages" : "no messages", ok: count > 0 };
    }
    case "token":
      return { mirror: `${body.type} ${body.symbol}`, ok: Boolean(body.token_id) };
    case "schedule": {
      const state = body.executed_timestamp ? "executed" : body.deleted ? "deleted" : "pending";
      return { mirror: state, ok: Boolean(body.schedule_id) };
    }
  }
}

function expectedLabel(link: DistinctLink): string {
  if (link.kind !== "transaction") return "";
  const { expect } = link;
  if (expect.type === "success") return "SUCCESS";
  return expect.status ?? "failure";
}

const short = (id: string) => (id.length > 30 ? `${id.slice(0, 14)}...${id.slice(-8)}` : id);

function printTable(rows: Row[], pending: PendingMarker[]): void {
  console.log("| Link | Type | Expected | Mirror result | Where | Status |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const { link, mirror, ok } of rows) {
    const status = ok ? "ok" : link.archived ? "fail (archived, ignored)" : "FAIL";
    const where = link.occurrences.slice(0, 2).join(", ") + (link.occurrences.length > 2 ? ", ..." : "");
    const label = `[${short(link.id)}](${link.url})`;
    console.log(`| ${label} | ${link.kind}${link.archived ? " (archived)" : ""} | ${expectedLabel(link)} | ${mirror} | ${where} | ${status} |`);
  }
  for (const marker of pending) {
    console.log(`| ${marker.file}:${marker.line} | marker | | ${marker.text.replace(/\|/g, "/").slice(0, 70)} | ${marker.file}:${marker.line} | pending demo run |`);
  }
}

async function main(): Promise<void> {
  const parsed = FILES.map((file) => parseEvidence(readFileSync(`${ROOT}${file}`, "utf8"), file));
  const distinct = dedupeLinks(parsed.flatMap((p) => p.links));
  const pending = parsed.flatMap((p) => p.pending);
  console.error(`${distinct.length} distinct links from ${parsed.reduce((n, p) => n + p.links.length, 0)} occurrences, mirror ${MIRROR}`);

  const rows: Row[] = [];
  for (const link of distinct) {
    try {
      rows.push({ link, ...(await checkLink(link)) });
    } catch (error) {
      rows.push({ link, mirror: (error as Error).message, ok: false });
    }
  }

  printTable(rows, pending);

  const ok = rows.filter((r) => r.ok).length;
  const ignored = rows.filter((r) => !r.ok && r.link.archived).length;
  const failed = rows.length - ok - ignored;
  console.log(`\nChecked ${rows.length} distinct links: ${ok} ok, ${failed} failed, ${ignored} archived failures ignored, ${pending.length} pending demo run markers.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
