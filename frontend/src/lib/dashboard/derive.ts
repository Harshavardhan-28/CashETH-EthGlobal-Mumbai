/**
 * Per-agent views over the MCP audit trail for the public /dashboard: which events concern an agent, its invoices,
 * its workers' budgets, a lender's positions and a buyer's dues. Pure functions; amounts are USDC base-unit strings.
 * Unit maths uses Number (exact up to 9e15 units, i.e. 9 billion USDC), always rounded back to an integer string.
 */
import type { AgentStats, AuditEvent, LenderYield, ReceivableDetails, ReceivableState } from "@/lib/admin/api";

export type InvoiceState = ReceivableState | "Rejected";

export type LenderShare = { maker: string; principal?: string; aprBps?: number; fee?: string };

export type Invoice = {
  id: string;
  ref?: string;
  seller?: string;
  buyer?: string;
  amount?: string; // face value
  dueDate?: number; // unix seconds
  state: InvoiceState;
  funded: string;
  debt?: string; // still owed to lenders (live read API only)
  repaid: string;
  toLenders: string;
  toSeller: string;
  spent: string; // x402 spend committed against this invoice
  reserved: string; // open reservations
  lenders: LenderShare[];
  workers: string[];
  uploadedAt?: string;
  fundedAt?: string;
  repaidAt?: string;
  lastAt: string;
  proofUrl?: string;
  documentVerified?: boolean;
};

export const lc = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.toLowerCase() : undefined);
const num = (u: unknown): number => (typeof u === "string" && /^\d+$/.test(u) ? Number(u) : 0);
export const units = (n: number): string => String(Math.max(0, Math.round(n)));
export const addU = (...xs: (string | undefined)[]): string => units(xs.reduce((s, x) => s + num(x), 0));
export const subU = (a: string | undefined, b: string | undefined): string => units(num(a) - num(b));
export const ratio = (part: string | undefined, whole: string | undefined): number => (num(whole) > 0 ? Math.min(1, num(part) / num(whole)) : 0);

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(lc).filter((x): x is string => !!x) : []);

function fillsOf(e: AuditEvent): LenderShare[] {
  if (Array.isArray(e.fills) && e.fills.length) {
    return e.fills
      .map((f) => (typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {}))
      .filter((f) => lc(f.maker))
      .map((f) => ({
        maker: lc(f.maker)!,
        ...(typeof f.amount === "string" ? { principal: f.amount } : {}),
        ...(typeof f.aprBps === "number" ? { aprBps: f.aprBps } : {}),
      }));
  }
  const makers = list(e.makers);
  // A single maker funded all of it; with several and no fills the split is unknown.
  return makers.map((maker) => (makers.length === 1 && typeof e.amount === "string" ? { maker, principal: e.amount } : { maker }));
}

function stateOf(types: Set<string>): InvoiceState {
  if (types.has("Defaulted")) return "Defaulted";
  if (types.has("Repaid")) return "Repaid";
  if (types.has("Overdue")) return "Overdue";
  if (types.has("FacilityFunded")) return "Financed";
  if (types.has("ReceivableConfirmed")) return "Confirmed";
  if (types.has("ReceivableRejected")) return "Rejected";
  return "Pending";
}

/** One invoice per receivable id, built from its events (oldest first) and enriched with `/receivables/:id` when known. Newest activity first. */
export function buildInvoices(events: AuditEvent[], refs: ReadonlyMap<string, string>, details: ReadonlyMap<string, ReceivableDetails> = new Map()): Invoice[] {
  const byId = new Map<string, AuditEvent[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const id = lc(e.id);
    if (!id) continue;
    const group = byId.get(id);
    if (group) group.push(e);
    else byId.set(id, [e]);
  }

  const out: Invoice[] = [];
  for (const [id, evs] of byId) {
    const first = (t: string) => evs.find((e) => e.type === t);
    const all = (t: string) => evs.filter((e) => e.type === t);
    const terms = first("ReceivableConfirmed") ?? first("ReceivableUploaded");
    if (!terms && !first("FacilityFunded")) continue; // spend or rejection noise without an invoice behind it
    const funded = first("FacilityFunded");
    const repaid = all("Repaid");
    const spendDone = new Set(evs.filter((e) => e.type === "SpendCommitted" || e.type === "SpendReleased").map((e) => e.spendId));
    const workers = new Set<string>();
    for (const e of evs) {
      if (e.type === "BudgetsSet") list(e.workers).forEach((w) => workers.add(w));
      const w = lc(e.worker);
      if (w) workers.add(w);
    }
    const dueRaw = terms?.dueDate;
    const d = details.get(id);
    const shares = funded ? fillsOf(funded) : [];
    const lenders: LenderShare[] = d?.positions?.length
      ? d.positions.map((p) => ({ maker: p.maker.toLowerCase(), principal: p.principal, aprBps: p.aprBps, fee: p.fee }))
      : shares;
    const proof = [funded, first("ReceivableConfirmed"), ...evs].find((e) => typeof e?.hashscan === "string")?.hashscan;

    out.push({
      id: evs[0].id as string,
      ...(refs.get(id) ? { ref: refs.get(id) } : {}),
      seller: d?.seller.toLowerCase() ?? lc(terms?.seller) ?? lc(first("ReceivableUploaded")?.agent),
      buyer: d?.buyer.toLowerCase() ?? lc(terms?.buyer),
      amount: d?.amount ?? (typeof terms?.amount === "string" ? terms.amount : undefined),
      dueDate: d?.dueDate ?? (typeof dueRaw === "number" ? dueRaw : typeof dueRaw === "string" && /^\d+$/.test(dueRaw) ? Number(dueRaw) : undefined),
      state: d?.state ?? stateOf(new Set(evs.map((e) => e.type))),
      funded: d?.funded ?? (funded ? addU(funded.amount as string) : "0"),
      ...(d ? { debt: d.debt } : {}),
      repaid: addU(...repaid.map((e) => e.amount as string)),
      toLenders: addU(...repaid.map((e) => e.toLenders as string)),
      toSeller: addU(...repaid.map((e) => e.toSeller as string)),
      spent: addU(...all("SpendCommitted").map((e) => e.amount as string)),
      reserved: addU(...all("SpendReserved").filter((e) => !spendDone.has(e.spendId)).map((e) => e.amount as string)),
      lenders,
      workers: [...workers],
      ...(first("ReceivableUploaded") ? { uploadedAt: first("ReceivableUploaded")!.ts } : {}),
      ...(funded ? { fundedAt: funded.ts } : {}),
      ...(repaid.length ? { repaidAt: repaid[repaid.length - 1].ts } : {}),
      lastAt: evs[evs.length - 1].ts,
      ...(typeof proof === "string" ? { proofUrl: proof } : {}),
      ...(d?.document ? { documentVerified: d.document.verified } : {}),
    });
  }
  return out.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/* ---------- which events concern an agent ---------- */

const BUYER_TYPES = new Set(["ReceivableUploaded", "ReceivableConfirmed", "ReceivableRejected", "NftMinted", "Repaid", "Overdue", "Defaulted", "Disputed"]);
const LENDER_TYPES = new Set(["FacilityFunded", "Repaid", "Overdue", "Defaulted", "Disputed"]);

/** Addresses an event names directly: the caller, worker, parties, registered agent, lenders and budgeted workers. */
export function namedIn(e: AuditEvent): Set<string> {
  const out = new Set<string>();
  for (const k of ["agent", "worker", "seller", "buyer", "evmAddress"]) {
    const v = lc(e[k]);
    if (v) out.add(v);
  }
  list(e.makers).forEach((m) => out.add(m));
  list(e.workers).forEach((w) => out.add(w));
  if (Array.isArray(e.fills)) for (const f of e.fills) if (typeof f === "object" && f) { const m = lc((f as { maker?: unknown }).maker); if (m) out.add(m); }
  return out;
}

/**
 * Events that concern `address` in `role`: those naming it, plus, through its invoices, what happened to them.
 * A seller sees everything on its invoices (its workers' spending, funding, repayment); a buyer the invoice lifecycle;
 * a lender funding, repayment and defaults.
 */
export function eventsFor(events: AuditEvent[], invoices: Invoice[], address: string, role: AgentStats["role"]): AuditEvent[] {
  const me = address.toLowerCase();
  const mine = new Set<string>();
  for (const inv of invoices) {
    const k = inv.id.toLowerCase();
    if (role === "seller" && inv.seller === me) mine.add(k);
    if (role === "buyer" && inv.buyer === me) mine.add(k);
    if (role === "lender" && inv.lenders.some((l) => l.maker === me)) mine.add(k);
  }
  return events.filter((e) => {
    if (namedIn(e).has(me)) return true;
    const id = lc(e.id);
    if (!id || !mine.has(id)) return false;
    if (role === "buyer") return BUYER_TYPES.has(e.type);
    if (role === "lender") return LENDER_TYPES.has(e.type);
    return true;
  });
}

/* ---------- seller ---------- */

export type WorkerBudget = {
  address: string;
  budget: string; // latest allocation per invoice, summed
  spent: string;
  reserved: string;
  remaining: string;
  payments: number;
  blocked: number;
  merchants: { merchant: string; amount: string }[];
  lastAt?: string;
};

/** Budgets and spending of every worker on `invoices` (a seller's), most active first. */
export function workerBudgets(events: AuditEvent[], invoices: Invoice[]): WorkerBudget[] {
  const ids = new Set(invoices.map((i) => i.id.toLowerCase()));
  const evs = [...events].filter((e) => ids.has(lc(e.id) ?? "")).sort((a, b) => a.seq - b.seq);
  const latestAlloc = new Map<string, Map<string, string>>(); // invoice -> worker -> alloc
  const done = new Set(evs.filter((e) => e.type === "SpendCommitted" || e.type === "SpendReleased").map((e) => e.spendId));
  const rows = new Map<string, WorkerBudget>();
  const row = (w: string) => {
    let r = rows.get(w);
    if (!r) rows.set(w, (r = { address: w, budget: "0", spent: "0", reserved: "0", remaining: "0", payments: 0, blocked: 0, merchants: [] }));
    return r;
  };

  for (const e of evs) {
    if (e.type === "BudgetsSet") {
      const workers = list(e.workers);
      const alloc = Array.isArray(e.alloc) ? e.alloc : [];
      const m = new Map<string, string>();
      workers.forEach((w, i) => m.set(w, typeof alloc[i] === "string" ? (alloc[i] as string) : "0"));
      latestAlloc.set(lc(e.id)!, m);
      workers.forEach((w) => (row(w).lastAt = e.ts));
      continue;
    }
    const w = lc(e.worker);
    if (!w) continue;
    const r = row(w);
    r.lastAt = e.ts;
    if (e.type === "SpendCommitted") {
      r.spent = addU(r.spent, e.amount as string);
      r.payments += 1;
      const merchant = (typeof e.merchant === "string" && e.merchant) || "unknown";
      const hit = r.merchants.find((x) => x.merchant === merchant);
      if (hit) hit.amount = addU(hit.amount, e.amount as string);
      else r.merchants.push({ merchant, amount: addU(e.amount as string) });
    }
    if (e.type === "SpendReserved" && !done.has(e.spendId)) r.reserved = addU(r.reserved, e.amount as string);
    if (e.type === "SpendRejected") r.blocked += 1;
  }
  for (const m of latestAlloc.values()) for (const [w, a] of m) row(w).budget = addU(row(w).budget, a);
  for (const r of rows.values()) r.remaining = subU(r.budget, addU(r.spent, r.reserved));
  return [...rows.values()].sort((a, b) => Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? "") || 0);
}

export type SellerSummary = {
  raised: string;
  owed: string;
  spent: string;
  reserved: string;
  available: string;
  receivedFromBuyers: string;
  paidToLenders: string;
  keptBySeller: string;
  open: number;
};

const OPEN: InvoiceState[] = ["Financed", "Overdue"];

/** Still owed to lenders: the live `debt` when known, else the funded principal while the loan is open (fees unknown). */
export const owedOn = (i: Invoice): string => i.debt ?? (OPEN.includes(i.state) || i.state === "Defaulted" ? i.funded : "0");

export function sellerSummary(invoices: Invoice[]): SellerSummary {
  const raised = addU(...invoices.map((i) => i.funded));
  const spent = addU(...invoices.map((i) => i.spent));
  const reserved = addU(...invoices.map((i) => i.reserved));
  return {
    raised,
    owed: addU(...invoices.map(owedOn)),
    spent,
    reserved,
    available: addU(...invoices.filter((i) => OPEN.includes(i.state)).map((i) => subU(i.funded, addU(i.spent, i.reserved)))),
    receivedFromBuyers: addU(...invoices.map((i) => i.repaid)),
    paidToLenders: addU(...invoices.map((i) => i.toLenders)),
    keptBySeller: addU(...invoices.map((i) => i.toSeller)),
    open: invoices.filter((i) => OPEN.includes(i.state)).length,
  };
}

/* ---------- buyer ---------- */

export type BuyerSummary = { due: string; dueCount: number; nextDue?: Invoice; paid: string; overdue: number };

const UNPAID: InvoiceState[] = ["Pending", "Confirmed", "Financed", "Overdue", "Defaulted"];

export const outstanding = (i: Invoice): string => (UNPAID.includes(i.state) ? subU(i.amount, i.repaid) : "0");

export function buyerSummary(invoices: Invoice[]): BuyerSummary {
  const unpaid = invoices.filter((i) => num(outstanding(i)) > 0 && i.state !== "Pending");
  const dated = unpaid.filter((i) => i.dueDate).sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
  return {
    due: addU(...unpaid.map(outstanding)),
    dueCount: unpaid.length,
    ...(dated[0] ? { nextDue: dated[0] } : {}),
    paid: addU(...invoices.map((i) => i.repaid)),
    overdue: unpaid.filter((i) => i.state === "Overdue" || i.state === "Defaulted").length,
  };
}

/** Days until `dueDate` (negative once past), whole days rounded toward the deadline. */
export function daysUntil(dueDate: number, nowMs: number): number {
  const d = (dueDate * 1000 - nowMs) / 86_400_000;
  return d >= 0 ? Math.ceil(d) : Math.floor(d);
}

/* ---------- lender ---------- */

export type Position = { invoice: Invoice; principal?: string; aprBps?: number; fee?: string };

export function lenderPositions(invoices: Invoice[], address: string): Position[] {
  const me = address.toLowerCase();
  const out: Position[] = [];
  for (const invoice of invoices) {
    const share = invoice.lenders.find((l) => l.maker === me);
    if (share) out.push({ invoice, ...(share.principal ? { principal: share.principal } : {}), ...(share.aprBps !== undefined ? { aprBps: share.aprBps } : {}), ...(share.fee ? { fee: share.fee } : {}) });
  }
  return out;
}

export function lenderOf(lenders: LenderYield[], address: string): LenderYield | undefined {
  return lenders.find((l) => l.address.toLowerCase() === address.toLowerCase());
}

/* ---------- which MCP tool produced an event ---------- */

/**
 * The CashETH MCP tool behind an audit event. Calls a seller made on its counterparties' behalf carry a derived
 * `jti` (`<seller jti>:<uuid>`, orchestrator/counterparty.ts), so they are attributed to the seller-driven tool.
 */
export function toolOf(e: AuditEvent): string {
  const viaSeller = typeof e.jti === "string" && e.jti.includes(":");
  switch (e.type) {
    case "AgentRegistered":
      return "register_agent";
    case "InvoiceDocumentStored":
      return "upload_invoice_document";
    case "ReceivableUploaded":
      return "upload_receivable";
    case "ReceivableConfirmed":
    case "NftMinted":
      return viaSeller ? "request_buyer_confirmation" : "confirm_receivable";
    case "ReceivableRejected":
      return e.stage === "upload" ? "upload_receivable" : viaSeller ? "request_buyer_confirmation" : "confirm_receivable";
    case "FacilityFunded":
      return "open_facility";
    case "BudgetsSet":
      return "set_budgets";
    case "SpendReserved":
      return viaSeller ? "buy_with_credit" : "reserve_spend";
    case "SpendCommitted":
      return viaSeller ? "buy_with_credit" : "commit_spend";
    case "SpendReleased":
      return "release_spend";
    case "SpendRejected":
      return viaSeller ? "buy_with_credit" : e.stage === "cosigner" ? "pay_x402" : "reserve_spend";
    case "Repaid":
      return viaSeller ? "settle_receivable" : "repay_receivable";
    case "StrategyShipped":
      return "fund_agents";
    case "StrategyDocked":
      return "close_strategy";
    case "Overdue":
    case "Defaulted":
      return "hedera_schedule";
    case "LlmToolCall":
      return typeof e.tool === "string" ? e.tool : "tool_call";
    default:
      return e.type;
  }
}
