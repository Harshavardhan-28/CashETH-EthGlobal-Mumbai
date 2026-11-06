/**
 * Derived views over narrated audit events: one run per invoice, KPI numbers, chart buckets and agent rows.
 * Pure functions of their inputs (the caller passes `nowMs`). Amount maths stays on decimal strings.
 * Every spend event carries the receivable `id` (orchestrator/spend.ts), so spends group with their invoice directly.
 */
import type { AgentStats, LenderYield } from "./api";
import { formatUsdc, initials, shortAddress } from "./format";
import type { Actor, ActorRole, Narrated } from "./narrate";

export type Range = "1h" | "24h" | "7d" | "all";
export const RANGE_MS: Record<Exclude<Range, "all">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
export const ACTIVE_WINDOW_MS = 120_000;
export const SETUP_RUN_ID = "setup";

const ROLES: ActorRole[] = ["seller", "buyer", "worker", "lender", "mcp"];
const SPARK_POINTS = 12;

const timeOf = (n: Narrated): number => {
  const t = Date.parse(n.ts);
  return Number.isNaN(t) ? 0 : t;
};

/** Decimal-string addition; non-numeric operands count as "0". */
function addUnits(a: string, b: string): string {
  const x = /^\d+$/.test(a) ? a : "0";
  const y = /^\d+$/.test(b) ? b : "0";
  const len = Math.max(x.length, y.length);
  const xs = x.padStart(len, "0");
  const ys = y.padStart(len, "0");
  let out = "";
  let carry = 0;
  for (let i = len - 1; i >= 0; i--) {
    const sum = xs.charCodeAt(i) - 48 + (ys.charCodeAt(i) - 48) + carry;
    out = String(sum % 10) + out;
    carry = sum > 9 ? 1 : 0;
  }
  return (carry ? "1" : "") + out.replace(/^0+(?=\d)/, "");
}

const sumAmounts = (items: Narrated[]): string => items.reduce((acc, i) => addUnits(acc, i.amount ?? "0"), "0");
const usd = (units: string): number => Number(units) / 1e6;

export function inRange(items: Narrated[], range: Range, nowMs: number): Narrated[] {
  if (range === "all") return items;
  const from = nowMs - RANGE_MS[range];
  return items.filter((i) => {
    const t = Date.parse(i.ts);
    return !Number.isNaN(t) && t >= from;
  });
}

/* ---------- runs ---------- */

export type RunStatus = "in_progress" | "repaid" | "overdue" | "defaulted" | "rejected";
export type RunStep = { label: string; done: boolean; current: boolean; who?: string; ts?: string };
export type Run = {
  id: string;
  title: string;
  ref?: string;
  status: RunStatus;
  amount?: string;
  startedAt: string;
  lastAt: string;
  events: Narrated[]; // oldest first
  steps: RunStep[]; // always 5
};

const STEPS: { label: string; types: string[] }[] = [
  { label: "Invoice uploaded", types: ["ReceivableUploaded", "InvoiceDocumentStored"] },
  { label: "Buyer confirmed", types: ["ReceivableConfirmed", "NftMinted"] },
  { label: "Lenders funded", types: ["FacilityFunded"] },
  { label: "Agents spending", types: ["SpendReserved", "SpendCommitted"] },
  { label: "Repaid", types: ["Repaid"] },
];
const AMOUNT_TYPES = new Set(["ReceivableUploaded", "ReceivableConfirmed", "FacilityFunded"]);

function statusOf(events: Narrated[]): RunStatus {
  const has = (t: string) => events.some((e) => e.type === t);
  if (has("Defaulted")) return "defaulted";
  if (has("ReceivableRejected")) return "rejected";
  if (has("Repaid")) return "repaid";
  if (has("Overdue")) return "overdue";
  return "in_progress";
}

function buildRun(id: string, events: Narrated[], isSetup: boolean): Run {
  const status = isSetup ? "in_progress" : statusOf(events);
  let currentSet = isSetup || status !== "in_progress";
  const steps: RunStep[] = STEPS.map(({ label, types }) => {
    const first = isSetup ? undefined : events.find((e) => types.includes(e.type));
    const current = !first && !currentSet;
    if (current) currentSet = true;
    return { label, done: !!first, current, ...(first ? { who: first.actor.name, ts: first.ts } : {}) };
  });
  const ref = events.find((e) => e.ref)?.ref;
  const amount = events.find((e) => AMOUNT_TYPES.has(e.type) && e.amount)?.amount;
  return {
    id,
    title: isSetup ? "Setup & other" : `Invoice ${ref ?? shortAddress(id)}`,
    ...(ref && !isSetup ? { ref } : {}),
    status,
    ...(amount && !isSetup ? { amount } : {}),
    startedAt: events[0].ts,
    lastAt: events[events.length - 1].ts,
    events,
    steps,
  };
}

/** One run per receivable id (compared case-insensitively), newest activity first; events without an id form the setup group, last. */
export function groupRuns(items: Narrated[]): Run[] {
  const oldestFirst = [...items].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, { id: string; events: Narrated[] }>();
  const setup: Narrated[] = [];
  for (const item of oldestFirst) {
    if (!item.id) {
      setup.push(item);
      continue;
    }
    const key = item.id.toLowerCase();
    const group = groups.get(key);
    if (group) group.events.push(item);
    else groups.set(key, { id: item.id, events: [item] });
  }
  const runs = [...groups.values()]
    .map((g) => buildRun(g.id, g.events, false))
    .sort((a, b) => timeOf(b.events[b.events.length - 1]) - timeOf(a.events[a.events.length - 1]) || b.events[b.events.length - 1].seq - a.events[a.events.length - 1].seq);
  if (setup.length) runs.push(buildRun(SETUP_RUN_ID, setup, true));
  return runs;
}

/* ---------- buckets and KPIs ---------- */

/** Equal-width time buckets: the range ending now, or for `all` from the oldest event to now. */
function bucketing(items: Narrated[], range: Range, nowMs: number, count: number) {
  let start = nowMs - (range === "all" ? count : RANGE_MS[range]);
  if (range === "all") {
    const times = items.map((i) => Date.parse(i.ts)).filter((t) => !Number.isNaN(t));
    if (times.length) start = Math.min(nowMs - count, ...times);
  }
  const width = (nowMs - start) / count;
  const index = (ts: string): number | undefined => {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || t < start) return undefined;
    return Math.min(count - 1, Math.floor((t - start) / width));
  };
  return { start, width, index };
}

export type Kpis = {
  agents: number;
  activeNow: number;
  financed: string;
  financedInRange: string;
  spent: string;
  payments: number;
  records: number;
  lastRecordAt?: string;
  spark: { agents: number[]; financed: number[]; spent: number[]; records: number[] };
};

export function computeKpis(all: Narrated[], agents: AgentStats[], range: Range, nowMs: number): Kpis {
  const scoped = inRange(all, range, nowMs);
  const funded = (items: Narrated[]) => items.filter((i) => i.type === "FacilityFunded");
  const committed = scoped.filter((i) => i.type === "SpendCommitted");

  const active = new Set<string>();
  for (const i of all) {
    const age = nowMs - Date.parse(i.ts);
    if (age <= ACTIVE_WINDOW_MS) active.add(i.actor.key);
  }

  let lastRecord: Narrated | undefined;
  for (const i of all) if (!lastRecord || timeOf(i) > timeOf(lastRecord)) lastRecord = i;

  const { index } = bucketing(scoped, range, nowMs, SPARK_POINTS);
  const financed = new Array<number>(SPARK_POINTS).fill(0);
  const spent = new Array<number>(SPARK_POINTS).fill(0);
  const records = new Array<number>(SPARK_POINTS).fill(0);
  const actors: Set<string>[] = Array.from({ length: SPARK_POINTS }, () => new Set<string>());
  for (const i of scoped) {
    const b = index(i.ts);
    if (b === undefined) continue;
    records[b] += 1;
    actors[b].add(i.actor.key);
    if (i.type === "FacilityFunded" && i.amount) financed[b] += usd(i.amount);
    if (i.type === "SpendCommitted" && i.amount) spent[b] += usd(i.amount);
  }
  for (let b = 1; b < SPARK_POINTS; b++) {
    financed[b] += financed[b - 1];
    spent[b] += spent[b - 1];
  }

  return {
    agents: agents.length,
    activeNow: active.size,
    financed: sumAmounts(funded(all)),
    financedInRange: sumAmounts(funded(scoped)),
    spent: sumAmounts(committed),
    payments: committed.length,
    records: scoped.length,
    ...(lastRecord ? { lastRecordAt: lastRecord.ts } : {}),
    spark: { agents: actors.map((s) => s.size), financed, spent, records },
  };
}

export type RoleBucket = { start: number; counts: Record<ActorRole, number> };

export function roleBuckets(items: Narrated[], range: Range, nowMs: number, buckets = SPARK_POINTS): RoleBucket[] {
  const scoped = inRange(items, range, nowMs);
  const { start, width, index } = bucketing(scoped, range, nowMs, buckets);
  const out: RoleBucket[] = Array.from({ length: buckets }, (_, i) => ({
    start: start + i * width,
    counts: Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<ActorRole, number>,
  }));
  for (const i of scoped) {
    const b = index(i.ts);
    if (b !== undefined) out[b].counts[i.actor.role] += 1;
  }
  return out;
}

/* ---------- agents ---------- */

export type AgentRow = { stats: AgentStats; actor: Actor; status: "active" | "idle"; last?: Narrated; money: string };

function moneyOf(a: AgentStats, key: string, all: Narrated[], lenders: LenderYield[]): string {
  switch (a.role) {
    case "worker":
      return `${formatUsdc(Object.values(a.spendByMerchant ?? {}).reduce((acc, v) => addUnits(acc, v), "0"))} spent`;
    case "lender": {
      const entry = lenders.find((l) => l.address.toLowerCase() === key);
      return entry ? `${formatUsdc(entry.lent)} lent` : "—";
    }
    case "seller": {
      const borrowed = groupRuns(all)
        .filter((r) => r.id !== SETUP_RUN_ID && r.events.find((e) => STEPS[0].types.includes(e.type))?.actor.key === key)
        .reduce((acc, r) => addUnits(acc, sumAmounts(r.events.filter((e) => e.type === "FacilityFunded"))), "0");
      return `${formatUsdc(borrowed)} borrowed`;
    }
    case "buyer":
      return `${formatUsdc(sumAmounts(all.filter((e) => e.type === "Repaid" && e.actor.key === key)))} repaid`;
    default:
      return "—";
  }
}

/** One row per agent: active first (an event within ACTIVE_WINDOW_MS), then by last activity, newest first. */
export function agentRows(agents: AgentStats[], all: Narrated[], lenders: LenderYield[], nowMs: number): AgentRow[] {
  const lastByKey = new Map<string, Narrated>();
  for (const i of all) {
    const prev = lastByKey.get(i.actor.key);
    if (!prev || i.seq > prev.seq) lastByKey.set(i.actor.key, i);
  }
  const rows = agents.map((stats): AgentRow => {
    const key = stats.address.toLowerCase();
    const name = stats.label || shortAddress(stats.address);
    const last = lastByKey.get(key);
    const status = last && nowMs - Date.parse(last.ts) <= ACTIVE_WINDOW_MS ? "active" : "idle";
    return {
      stats,
      actor: { key, name, role: stats.role, initials: initials(name), address: key },
      status,
      ...(last ? { last } : {}),
      money: moneyOf(stats, key, all, lenders),
    };
  });
  const lastAt = (r: AgentRow) => (r.last ? timeOf(r.last) : -1);
  return rows.sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || lastAt(b) - lastAt(a));
}
