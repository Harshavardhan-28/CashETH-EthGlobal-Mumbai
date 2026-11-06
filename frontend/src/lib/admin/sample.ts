/**
 * Sample data shown only while the MCP server has never answered, always behind the
 * "Sample data · MCP server offline" label. It tells the real story in the real event shapes
 * (field names from apps/mcp-server/src/orchestrator), so the page stays demonstrable offline.
 */
import type { AgentStats, AuditEvent, LenderYield } from "./api";

/** Deterministic hex that looks like a real address/hash (same tag → same value). */
function hex(tag: string, length: number): string {
  let x = 2166136261;
  for (const c of tag) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = "";
  while (out.length < length) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}
const addr = (tag: string) => `0x${hex(`a:${tag}`, 40)}`;
const hash = (tag: string) => `0x${hex(`h:${tag}`, 64)}`;
const tx = (tag: string) => `https://hashscan.io/testnet/transaction/${hash(tag)}`;

const SELLER = addr("a11ce5e11e7");
const BUYER = addr("b0b0b0b0b0b");
const WORKER_1 = addr("c0de0001");
const WORKER_2 = addr("c0de0002");
const LENDER_A = addr("1e7d00a");
const LENDER_B = addr("1e7d00b");
const DATA_API = addr("da7aa910");
const SEARCH_API = addr("5ea4c4a9");

function agent(address: string, role: AgentStats["role"], label: string, extra: Partial<AgentStats> = {}): AgentStats {
  return {
    address,
    uaid: `uaid:aid:${label.toLowerCase().replace(/\s+/g, "-")}`,
    role,
    label,
    level: 2,
    score: 70,
    tier: "none",
    onTimePct: 0,
    receivablesFunded: 0,
    receivablesRepaid: 0,
    receivablesDefaulted: 0,
    avgDaysToRepay: 0,
    spendByMerchant: {},
    lenderReturnPct: 0,
    ...extra,
  };
}

export const SAMPLE_AGENTS: AgentStats[] = [
  agent(SELLER, "seller", "Seller", { level: 2, score: 71, tier: "low", onTimePct: 100, receivablesFunded: 3, receivablesRepaid: 2, avgDaysToRepay: 0.8 }),
  agent(BUYER, "buyer", "Buyer", { level: 2, score: 82, tier: "low", onTimePct: 100, receivablesFunded: 3, receivablesRepaid: 2, avgDaysToRepay: 0.8 }),
  agent(WORKER_1, "worker", "Worker 1", { level: 1, score: 68, spendByMerchant: { [DATA_API]: "3600000" } }),
  agent(WORKER_2, "worker", "Worker 2", { level: 1, score: 64, spendByMerchant: { [SEARCH_API]: "4900000" } }),
  agent(LENDER_A, "lender", "Lender A", { level: 3, score: 90, lenderReturnPct: 9.4 }),
  agent(LENDER_B, "lender", "Lender B", { level: 3, score: 86, lenderReturnPct: 7.1 }),
];

export const SAMPLE_LENDERS: LenderYield[] = [
  { address: LENDER_A, label: "Lender A", tier: "low", capital: "5000000000", lent: "1000000000", idle: "4000000000", baseFees: "1200000", creditFees: "6400000", baseApr: 4.2, boostApr: 12, blendedApr: 9.4, strategies: {} },
  { address: LENDER_B, label: "Lender B", tier: "medium", capital: "3000000000", lent: "300000000", idle: "2700000000", baseFees: "600000", creditFees: "2100000", baseApr: 3.8, boostApr: 10, blendedApr: 7.1, strategies: {} },
];

type Draft = { at: number /* ms before now */; type: string; [k: string]: unknown };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function invoice(ref: string, tag: string, amount: string, start: number, lenders: string[], spends: { worker: string; merchant: string; amount: string; at: number }[], repaidAt?: number): Draft[] {
  const id = hash(`f${tag}`);
  const doc = hash(`d0c${tag}`);
  const out: Draft[] = [
    { at: start, type: "InvoiceDocumentStored", receivableRef: ref, keccak256: doc, sha256: hash(`5a${tag}`), bytes: 48213, mime: "application/pdf", agent: SELLER },
    { at: start - 20_000, type: "ReceivableUploaded", id, seller: SELLER, buyer: BUYER, amount, documentKeccak: doc, agent: SELLER },
    { at: start - 50_000, type: "ReceivableConfirmed", id, amount, agent: BUYER, hashscan: tx(`c${tag}`) },
    { at: start - 65_000, type: "NftMinted", id, serial: Number(tag), agent: BUYER, hashscan: tx(`a${tag}`) },
    { at: start - 95_000, type: "FacilityFunded", id, amount, makers: lenders, agent: SELLER, hashscan: tx(`b${tag}`) },
    { at: start - 120_000, type: "BudgetsSet", id, agent: SELLER, hashscan: tx(`e${tag}`) },
  ];
  spends.forEach((s, i) => {
    const spendId = hash(`5e${tag}${i}`);
    out.push({ at: s.at, type: "SpendReserved", id, spendId, worker: s.worker, merchant: s.merchant, amount: s.amount, agent: s.worker, hashscan: tx(`7${tag}${i}`) });
    out.push({ at: s.at - 25_000, type: "SpendCommitted", id, spendId, worker: s.worker, merchant: s.merchant, amount: s.amount, agent: s.worker, hashscan: tx(`8${tag}${i}`) });
  });
  if (repaidAt !== undefined) out.push({ at: repaidAt, type: "Repaid", id, amount, agent: BUYER, hashscan: tx(`9${tag}`) });
  return out;
}

function drafts(): Draft[] {
  const setup: Draft[] = SAMPLE_AGENTS.map((a, i) => ({
    at: 3 * DAY - i * MIN,
    type: "AgentRegistered",
    agentUaid: a.uaid,
    name: a.label,
    role: a.role,
    evmAddress: a.address,
    level: a.level,
    hashscan: tx(`ab${i}`),
  }));
  setup.push(
    { at: 3 * DAY - 10 * MIN, type: "StrategyShipped", agent: LENDER_A, hashscan: tx("51a") },
    { at: 3 * DAY - 12 * MIN, type: "StrategyShipped", agent: LENDER_B, hashscan: tx("51b") },
  );

  const po1003 = invoice("PO-1003", "3", "800000000", 10 * MIN, [LENDER_A, LENDER_B], [
    { worker: WORKER_1, merchant: DATA_API, amount: "1200000", at: 3 * MIN },
    { worker: WORKER_2, merchant: SEARCH_API, amount: "800000", at: 45_000 },
  ]);
  const po1003Id = hash("f3");
  po1003.push({ at: 70_000, type: "SpendRejected", id: po1003Id, worker: WORKER_1, merchant: DATA_API, amount: "50000000", code: "AGENT_BUDGET_EXCEEDED", stage: "reserve", agent: WORKER_1 });

  return [
    ...setup,
    ...invoice("PO-1001", "1", "1200000000", 2 * DAY, [LENDER_A, LENDER_B], [{ worker: WORKER_1, merchant: DATA_API, amount: "2400000", at: 2 * DAY - 30 * MIN }], DAY),
    ...invoice("PO-1002", "2", "1600000000", 20 * HOUR, [LENDER_A], [{ worker: WORKER_2, merchant: SEARCH_API, amount: "4100000", at: 19 * HOUR }], 6 * HOUR),
    ...po1003,
  ];
}

/** The sample story with timestamps relative to `nowMs`, oldest first, seq 1..n with HCS sequence numbers. */
export function sampleEvents(nowMs: number): AuditEvent[] {
  return drafts()
    .sort((a, b) => b.at - a.at)
    .map(({ at, ...rest }, i): AuditEvent => ({ ...rest, v: 1, seq: i + 1, prevSeq: i, ts: new Date(nowMs - at).toISOString(), hcsSeq: 400 + i }));
}
