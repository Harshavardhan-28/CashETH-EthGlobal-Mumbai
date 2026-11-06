import { describe, expect, it } from "vitest";
import type { AgentStats, LenderYield } from "./api";
import type { Actor, ActorRole, Narrated } from "./narrate";
import { ACTIVE_WINDOW_MS, addUnits, agentRows, computeKpis, groupRuns, inRange, roleBuckets, SETUP_RUN_ID } from "./derive";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const actor = (name: string, role: ActorRole, address?: string): Actor => ({
  key: address ?? `${role}:${name}`,
  name,
  role,
  initials: name.slice(0, 2).toUpperCase(),
  ...(address ? { address } : {}),
});
const SELLER = actor("Acme Seller", "seller", "0xseller");
const BUYER = actor("Big Buyer", "buyer", "0xbuyer");
const WORKER = actor("Worker One", "worker", "0xworker");
const LENDERS = actor("Lenders", "lender");

const ID2 = "0x" + "a2".repeat(32);
const ID3 = "0x" + "a3".repeat(32);

let seq = 0;
function n(type: string, a: Actor, ts: string, over: Partial<Narrated> = {}): Narrated {
  seq += 1;
  return { seq, ts, type, actor: a, sentence: type, detail: "", tone: "ok", ...over };
}

function fixture(): Narrated[] {
  seq = 0;
  const big = "9007199254740993";
  return [
    n("AgentRegistered", WORKER, ago(180 * MIN)),
    // PO-1002: full lifecycle, repaid
    n("ReceivableUploaded", SELLER, ago(150 * MIN), { id: ID2, ref: "PO-1002", amount: big }),
    n("InvoiceDocumentStored", SELLER, ago(149 * MIN), { id: ID2, ref: "PO-1002" }),
    n("ReceivableConfirmed", BUYER, ago(148 * MIN), { id: ID2, ref: "PO-1002", amount: big }),
    n("FacilityFunded", LENDERS, ago(147 * MIN), { id: ID2, ref: "PO-1002", amount: big }),
    n("SpendReserved", WORKER, ago(146 * MIN), { id: ID2, ref: "PO-1002", amount: "500" }),
    n("SpendCommitted", WORKER, ago(145 * MIN), { id: ID2, ref: "PO-1002", amount: "500" }),
    n("Repaid", BUYER, ago(120 * MIN), { id: ID2.toUpperCase().replace("0X", "0x"), ref: "PO-1002", amount: big }),
    // PO-1003: uploaded -> confirmed -> funded -> one payment
    n("ReceivableUploaded", SELLER, ago(50 * MIN), { id: ID3, ref: "PO-1003", amount: "3000000" }),
    n("ReceivableConfirmed", BUYER, ago(45 * MIN), { id: ID3, ref: "PO-1003", amount: "3000000" }),
    n("FacilityFunded", LENDERS, ago(40 * MIN), { id: ID3, ref: "PO-1003", amount: "1000001" }),
    n("SpendCommitted", WORKER, ago(30_000), { id: ID3, ref: "PO-1003", amount: "1200000" }),
    n("LlmRunFinished", actor("Worker", "worker"), ago(20 * MIN)),
  ];
}

describe("inRange", () => {
  it("returns everything for all and drops a 2-hour-old item for 1h", () => {
    const items = fixture();
    expect(inRange(items, "all", NOW)).toHaveLength(items.length);
    const hour = inRange(items, "1h", NOW);
    expect(hour.every((i) => NOW - Date.parse(i.ts) <= 3_600_000)).toBe(true);
    expect(hour.map((i) => i.seq)).toEqual(items.filter((i) => NOW - Date.parse(i.ts) <= 3_600_000).map((i) => i.seq));
    expect(hour.length).toBeLessThan(items.length);
  });
});

describe("groupRuns", () => {
  it("orders runs newest first with the setup group last", () => {
    const runs = groupRuns(fixture());
    expect(runs.map((r) => r.title)).toEqual(["Invoice PO-1003", "Invoice PO-1002", "Setup & other"]);
    expect(runs[2].id).toBe(SETUP_RUN_ID);
    expect(runs[0].ref).toBe("PO-1003");
  });

  it("merges ids that differ only in case and reports a repaid run with every step done", () => {
    const r = groupRuns(fixture()).find((x) => x.ref === "PO-1002")!;
    expect(r.status).toBe("repaid");
    expect(r.steps.map((s) => s.label)).toEqual(["Invoice uploaded", "Buyer confirmed", "Lenders funded", "Agents spending", "Repaid"]);
    expect(r.steps.every((s) => s.done)).toBe(true);
    expect(r.steps.some((s) => s.current)).toBe(false);
    expect(r.amount).toBe("9007199254740993");
    expect(r.events).toHaveLength(7);
    expect(r.events[0].seq).toBeLessThan(r.events[6].seq);
    expect(r.steps[0].who).toBe("Acme Seller");
    expect(r.startedAt).toBe(r.events[0].ts);
    expect(r.lastAt).toBe(r.events[6].ts);
  });

  it("shows an in-progress run with the current step marked", () => {
    const r = groupRuns(fixture()).find((x) => x.ref === "PO-1003")!;
    expect(r.status).toBe("in_progress");
    expect(r.steps.map((s) => s.done)).toEqual([true, true, true, true, false]);
    expect(r.steps.map((s) => s.current)).toEqual([false, false, false, false, true]);
    expect(r.amount).toBe("3000000");
  });

  it("collects events without an id in the setup group", () => {
    const setup = groupRuns(fixture()).find((x) => x.id === SETUP_RUN_ID)!;
    expect(setup.status).toBe("in_progress");
    expect(setup.steps).toHaveLength(5);
    expect(setup.steps.every((s) => !s.done && !s.current)).toBe(true);
    expect(setup.events.map((e) => e.type)).toEqual(["AgentRegistered", "LlmRunFinished"]);
  });

  it("falls back to the short id when no reference is known", () => {
    const runs = groupRuns([n("ReceivableUploaded", SELLER, ago(MIN), { id: ID3 })]);
    expect(runs[0].title).toBe(`Invoice ${ID3.slice(0, 6)}…${ID3.slice(-4)}`);
    expect(runs[0].ref).toBeUndefined();
  });

  it("lets Defaulted win over Repaid and Overdue, and ReceivableRejected beat Repaid", () => {
    const mk = (types: string[]) => groupRuns(types.map((t, i) => n(t, SELLER, ago((10 - i) * MIN), { id: ID2 })))[0].status;
    expect(mk(["ReceivableUploaded", "Overdue", "Repaid", "Defaulted"])).toBe("defaulted");
    expect(mk(["ReceivableUploaded", "Defaulted", "Repaid"])).toBe("defaulted");
    expect(mk(["ReceivableUploaded", "ReceivableRejected"])).toBe("rejected");
    expect(mk(["ReceivableUploaded", "Overdue"])).toBe("overdue");
    expect(mk(["ReceivableUploaded", "Overdue", "Repaid"])).toBe("repaid");
  });

  it("returns [] for no items", () => {
    expect(groupRuns([])).toEqual([]);
  });
});

describe("computeKpis", () => {
  const agents = [{ address: "0xworker" }, { address: "0xseller" }] as AgentStats[];

  it("sums financed exactly and counts only recent actors as active", () => {
    const k = computeKpis(fixture(), agents, "all", NOW);
    expect(k.agents).toBe(2);
    expect(k.financed).toBe("9007199255740994");
    expect(k.financedInRange).toBe("9007199255740994");
    expect(k.spent).toBe("1200500");
    expect(k.payments).toBe(2);
    expect(k.records).toBe(13);
    expect(k.lastRecordAt).toBe(ago(30_000));
    // only the SpendCommitted 30 s ago is inside the 120 s window
    expect(k.activeNow).toBe(1);
    for (const s of Object.values(k.spark)) expect(s).toHaveLength(12);
  });

  it("limits financedInRange, spent and records to the range", () => {
    const k = computeKpis(fixture(), agents, "1h", NOW);
    expect(k.financed).toBe("9007199255740994");
    expect(k.financedInRange).toBe("1000001");
    expect(k.spent).toBe("1200000");
    expect(k.payments).toBe(1);
    expect(k.records).toBe(5);
    expect(k.spark.financed[11]).toBeCloseTo(1.000001, 6);
    expect(k.spark.records.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("counts an actor active only inside the window", () => {
    const edge = [n("SpendCommitted", WORKER, ago(ACTIVE_WINDOW_MS + 1000)), n("SpendCommitted", SELLER, ago(ACTIVE_WINDOW_MS - 1000))];
    expect(computeKpis(edge, [], "1h", NOW).activeNow).toBe(1);
  });

  it("returns zeros for empty input without throwing", () => {
    for (const range of ["1h", "24h", "7d", "all"] as const) {
      const k = computeKpis([], [], range, NOW);
      expect(k).toMatchObject({ agents: 0, activeNow: 0, financed: "0", financedInRange: "0", spent: "0", payments: 0, records: 0 });
      expect(k.lastRecordAt).toBeUndefined();
      for (const s of Object.values(k.spark)) {
        expect(s).toHaveLength(12);
        expect(s.every((v) => v === 0)).toBe(true);
      }
    }
  });
});

describe("roleBuckets", () => {
  it("makes 12 buckets whose counts sum to the in-range count", () => {
    const items = fixture();
    const b = roleBuckets(items, "1h", NOW);
    expect(b).toHaveLength(12);
    const total = b.reduce((sum, x) => sum + Object.values(x.counts).reduce((a, c) => a + c, 0), 0);
    expect(total).toBe(inRange(items, "1h", NOW).length);
    expect(b[11].counts.worker).toBeGreaterThanOrEqual(1);
    expect(b[0].start).toBe(NOW - 3_600_000);
  });

  it("covers oldest event to now for all and handles empty input", () => {
    const items = fixture();
    const b = roleBuckets(items, "all", NOW, 6);
    expect(b).toHaveLength(6);
    expect(b.reduce((s, x) => s + Object.values(x.counts).reduce((a, c) => a + c, 0), 0)).toBe(items.length);
    expect(roleBuckets([], "all", NOW)).toHaveLength(12);
  });
});

describe("agentRows", () => {
  const stats = (address: string, role: AgentStats["role"], label: string, extra: Partial<AgentStats> = {}) =>
    ({ address, uaid: `uaid:${address}`, role, label, spendByMerchant: {}, ...extra }) as AgentStats;

  it("marks recently-acting agents active and sorts them first, with money labels by role", () => {
    const worker = stats("0xWorker", "worker", "Worker One", { spendByMerchant: { "0xm": "1200000" } });
    const seller = stats("0xSELLER", "seller", "Acme Seller");
    const buyer = stats("0xbuyer", "buyer", "Big Buyer");
    const lender = stats("0xLender", "lender", "Lender A");
    const lenders = [{ address: "0xlender", lent: "38200000" }] as LenderYield[];
    const items = fixture();
    const rows = agentRows([seller, buyer, lender, worker], items, lenders, NOW);
    expect(rows.map((r) => r.stats.label)[0]).toBe("Worker One");
    expect(rows[0].status).toBe("active");
    expect(rows[0].money).toBe("$1.20 spent");
    expect(rows[0].actor).toMatchObject({ key: "0xworker", name: "Worker One", role: "worker" });
    expect(rows[0].last?.type).toBe("SpendCommitted");
    const by = Object.fromEntries(rows.map((r) => [r.stats.label, r]));
    expect(by["Acme Seller"].status).toBe("idle");
    expect(by["Acme Seller"].money).toBe("$9,007,199,255.74 borrowed");
    expect(by["Big Buyer"].money).toBe("$9,007,199,254.74 repaid");
    expect(by["Lender A"].money).toBe("$38.20 lent");
    expect(by["Lender A"].last).toBeUndefined();
    // idle agents ordered by last activity: buyer (-45m) is ahead of seller (-50m); no-activity lender is last
    expect(rows.map((r) => r.stats.label)).toEqual(["Worker One", "Big Buyer", "Acme Seller", "Lender A"]);
  });

  it("degrades to a dash and survives garbage amounts", () => {
    const rows = agentRows([stats("0xl", "lender", "L"), stats("0xw", "worker", "W", { spendByMerchant: { a: "oops", b: "5" } })], [], [], NOW);
    expect(rows.find((r) => r.stats.label === "L")!.money).toBe("—");
    expect(rows.find((r) => r.stats.label === "W")!.money).toBe("$0.00 spent");
  });
});

describe("addUnits", () => {
  it("keeps the zeros that follow a final carry", () => {
    expect(addUnits("500", "500")).toBe("1000");
    expect(addUnits("99", "1")).toBe("100");
    expect(addUnits("999999", "1")).toBe("1000000");
    expect(addUnits("500000000", "500000000")).toBe("1000000000");
  });

  it("handles zeros, uneven lengths and garbage", () => {
    expect(addUnits("0", "0")).toBe("0");
    expect(addUnits("007", "5")).toBe("12");
    expect(addUnits("123", "oops")).toBe("123");
  });

  it("is exact through computeKpis with two $500 fundings", () => {
    seq = 0;
    const funded = [
      n("FacilityFunded", LENDERS, ago(2 * MIN), { id: ID2, amount: "500000000" }),
      n("FacilityFunded", LENDERS, ago(MIN), { id: ID3, amount: "500000000" }),
    ];
    const k = computeKpis(funded, [], "all", NOW);
    expect(k.financed).toBe("1000000000");
    expect(k.financedInRange).toBe("1000000000");
  });
});
