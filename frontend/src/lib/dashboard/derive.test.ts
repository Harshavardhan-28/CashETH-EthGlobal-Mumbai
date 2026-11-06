import { describe, expect, it } from "vitest";
import type { AuditEvent, ReceivableDetails } from "@/lib/admin/api";
import { SAMPLE_AGENTS, sampleEvents } from "@/lib/admin/sample";
import { buildInvoices, buyerSummary, daysUntil, eventsFor, lenderPositions, sellerSummary, toolOf, workerBudgets } from "./derive";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const events = sampleEvents(NOW);
const by = (role: string, label?: string) => SAMPLE_AGENTS.find((a) => a.role === role && (!label || a.label === label))!;
const SELLER = by("seller").address.toLowerCase();
const BUYER = by("buyer").address.toLowerCase();
const LENDER_A = by("lender", "Lender A").address.toLowerCase();
const LENDER_B = by("lender", "Lender B").address.toLowerCase();
const W1 = by("worker", "Worker 1").address.toLowerCase();

let seq = 0;
const ev = (type: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({ v: 1, type, seq: ++seq, prevSeq: seq - 1, ts: new Date(NOW - 1000 * (100 - seq)).toISOString(), ...extra });

describe("buildInvoices", () => {
  const invoices = buildInvoices(events, new Map());

  it("builds one invoice per receivable with parties, state and money from the events", () => {
    expect(invoices).toHaveLength(3);
    const open = invoices[0];
    expect(open).toMatchObject({ seller: SELLER, buyer: BUYER, state: "Financed", funded: "800000000", amount: "1000000000", spent: "2000000", repaid: "0" });
    expect(open.lenders.map((l) => l.maker)).toEqual([LENDER_A, LENDER_B]);
    expect(open.workers).toEqual(expect.arrayContaining([W1]));
    expect(open.dueDate).toBeGreaterThan(NOW / 1000);
    expect(invoices.slice(1).every((i) => i.state === "Repaid" && Number(i.toLenders) > 0 && Number(i.toSeller) > 0)).toBe(true);
  });

  it("prefers live /receivables details for state, debt and positions", () => {
    const id = invoices[0].id;
    const details: ReceivableDetails = {
      id,
      state: "Overdue",
      seller: SELLER,
      buyer: BUYER,
      amount: "1000000000",
      dueDate: 1,
      funded: "800000000",
      debt: "805000000",
      positions: [{ maker: LENDER_A.toUpperCase().replace("0X", "0x"), principal: "800000000", aprBps: 700, fee: "5000000" }],
      evidence: [],
    };
    const live = buildInvoices(events, new Map(), new Map([[id.toLowerCase(), details]]));
    expect(live[0]).toMatchObject({ state: "Overdue", debt: "805000000", dueDate: 1 });
    expect(live[0].lenders).toEqual([{ maker: LENDER_A, principal: "800000000", aprBps: 700, fee: "5000000" }]);
  });

  it("ignores ids with no invoice behind them", () => {
    expect(buildInvoices([ev("SpendRejected", { id: "0xdead", worker: W1 })], new Map())).toEqual([]);
  });
});

describe("role summaries", () => {
  const invoices = buildInvoices(events, new Map());

  it("seller: credit raised, spent, available and payback split", () => {
    const s = sellerSummary(invoices.filter((i) => i.seller === SELLER));
    expect(s.raised).toBe("3600000000");
    expect(s.spent).toBe("8500000");
    expect(s.available).toBe("798000000"); // the open invoice: 800 funded - 2 spent
    expect(s.open).toBe(1);
    expect(Number(s.paidToLenders) + Number(s.keptBySeller)).toBe(Number(s.receivedFromBuyers));
  });

  it("buyer: only the confirmed unpaid invoice is due", () => {
    const s = buyerSummary(invoices.filter((i) => i.buyer === BUYER));
    expect(s).toMatchObject({ due: "1000000000", dueCount: 1, overdue: 0, paid: "3500000000" });
    expect(s.nextDue?.state).toBe("Financed");
  });

  it("lender: positions with principal and APR from the fills", () => {
    const a = lenderPositions(invoices, LENDER_A);
    const b = lenderPositions(invoices, LENDER_B);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
    expect(a[0]).toMatchObject({ principal: "480000000", aprBps: 700 });
    expect(b[0]).toMatchObject({ principal: "320000000", aprBps: 850 });
  });

  it("worker budgets: latest allocation, spend, blocks and merchants", () => {
    const rows = workerBudgets(events, invoices.filter((i) => i.seller === SELLER));
    const w1 = rows.find((r) => r.address === W1)!;
    expect(w1.budget).toBe(String(20_000_000 + 30_000_000 + 40_000_000)); // 2.5% of 800, 1200, 1600
    expect(w1.spent).toBe("3600000");
    expect(w1.blocked).toBe(1);
    expect(w1.remaining).toBe(String(90_000_000 - 3_600_000));
    expect(w1.merchants).toHaveLength(1);
  });
});

describe("eventsFor", () => {
  const invoices = buildInvoices(events, new Map());
  const types = (addr: string, role: Parameters<typeof eventsFor>[3]) => new Set(eventsFor(events, invoices, addr, role).map((e) => e.type));

  it("gives a seller its workers' spending and the lenders' funding on its invoices", () => {
    const t = types(SELLER, "seller");
    for (const x of ["ReceivableUploaded", "FacilityFunded", "SpendCommitted", "SpendRejected", "Repaid", "BudgetsSet"]) expect(t.has(x)).toBe(true);
  });

  it("keeps worker spending out of the buyer's and lender's logs", () => {
    expect(types(BUYER, "buyer").has("SpendCommitted")).toBe(false);
    expect(types(BUYER, "buyer").has("Repaid")).toBe(true);
    const l = types(LENDER_B, "lender");
    expect(l.has("SpendCommitted")).toBe(false);
    expect(l.has("FacilityFunded")).toBe(true);
    expect(l.has("StrategyShipped")).toBe(true);
  });
});

describe("toolOf", () => {
  it("maps events to the MCP tool, including seller-driven counterparty calls", () => {
    expect(toolOf(ev("FacilityFunded"))).toBe("open_facility");
    expect(toolOf(ev("SpendCommitted", { jti: "abc" }))).toBe("commit_spend");
    expect(toolOf(ev("SpendCommitted", { jti: "abc:def" }))).toBe("buy_with_credit");
    expect(toolOf(ev("Repaid", { jti: "abc:def" }))).toBe("settle_receivable");
    expect(toolOf(ev("ReceivableConfirmed", { jti: "abc:def" }))).toBe("request_buyer_confirmation");
    expect(toolOf(ev("SpendRejected", { stage: "cosigner" }))).toBe("pay_x402");
    expect(toolOf(ev("ReceivableRejected", { stage: "upload" }))).toBe("upload_receivable");
    expect(toolOf(ev("Overdue"))).toBe("hedera_schedule");
    expect(toolOf(ev("SomethingNew"))).toBe("SomethingNew");
  });
});

describe("daysUntil", () => {
  it("counts whole days toward the deadline", () => {
    expect(daysUntil(NOW / 1000 + 86_400 * 1.5, NOW)).toBe(2);
    expect(daysUntil(NOW / 1000 - 86_400 * 1.5, NOW)).toBe(-2);
  });
});
