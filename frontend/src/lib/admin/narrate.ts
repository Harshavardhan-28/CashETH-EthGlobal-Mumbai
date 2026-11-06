/**
 * Plain-English narration of MCP-server audit events. The actor is rendered separately, so a sentence
 * starts with the verb ("paid $0.25 to ..."). Missing fields degrade to generic wording, never "undefined"/"NaN".
 */
import type { AgentStats, AuditEvent } from "./api";
import { formatUsdc, humanizeCode, initials, shortAddress } from "./format";

export type ActorRole = "seller" | "buyer" | "worker" | "lender" | "mcp";
export type Actor = { key: string; name: string; role: ActorRole; initials: string; address?: string };
export type Tone = "ok" | "blocked" | "warn" | "info";
export type Narrated = {
  seq: number;
  ts: string;
  type: string;
  id?: string;
  ref?: string; // human invoice label (PO reference), only when known
  spendId?: string;
  actor: Actor;
  sentence: string;
  detail: string;
  tone: Tone;
  amount?: string; // base units, when the event moved money
  proofUrl?: string;
};

type Text = { sentence: string; detail: string; tone: Tone };

const MCP_NAME = "CashETH MCP";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const lower = (v: unknown): string | undefined => str(v)?.toLowerCase();
const isRole = (v: unknown): v is Exclude<ActorRole, "mcp"> => v === "seller" || v === "buyer" || v === "worker" || v === "lender";

function makeActor(name: string, role: ActorRole, address?: string): Actor {
  const addr = address?.toLowerCase();
  return { key: addr ?? `${role}:${name}`, name, role, initials: initials(name), ...(addr ? { address: addr } : {}) };
}

function fromAgent(a: AgentStats): Actor {
  return makeActor(a.label || shortAddress(a.address), a.role, a.address);
}

/** Generic actor implied by what the event is, for callers that /agents does not know. */
const INFERRED: Record<string, { name: string; role: Exclude<ActorRole, "mcp"> }> = {
  ReceivableUploaded: { name: "Seller", role: "seller" },
  InvoiceDocumentStored: { name: "Seller", role: "seller" },
  BudgetsSet: { name: "Seller", role: "seller" },
  ReceivableConfirmed: { name: "Buyer", role: "buyer" },
  Repaid: { name: "Buyer", role: "buyer" },
  SpendReserved: { name: "Worker", role: "worker" },
  SpendCommitted: { name: "Worker", role: "worker" },
  SpendReleased: { name: "Worker", role: "worker" },
  SpendRejected: { name: "Worker", role: "worker" },
  StrategyShipped: { name: "Lenders", role: "lender" },
  StrategyDocked: { name: "Lenders", role: "lender" },
  FacilityFunded: { name: "Lenders", role: "lender" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lender addresses of a FacilityFunded event (`makers`, else `fills[].maker`), lowercased, deduplicated. */
function makersOf(e: AuditEvent): string[] {
  const fromMakers = Array.isArray(e.makers) ? e.makers : [];
  const fromFills = Array.isArray(e.fills) ? e.fills.map((f) => (typeof f === "object" && f !== null ? (f as { maker?: unknown }).maker : undefined)) : [];
  const all = (fromMakers.length ? fromMakers : fromFills).map(lower).filter((m): m is string => !!m);
  return [...new Set(all)];
}

export function resolveActor(e: AuditEvent, agents: AgentStats[]): Actor {
  const byAddress = (addr: string | undefined) => (addr ? agents.find((a) => a.address.toLowerCase() === addr) : undefined);
  const byUaid = (uaid: string | undefined) => (uaid ? agents.find((a) => a.uaid === uaid) : undefined);

  // The seller calls open_facility, so `agent` is the seller; the money comes from the lenders whose strategies filled.
  if (e.type === "FacilityFunded") {
    const lenders = makersOf(e)
      .map(byAddress)
      .filter((a): a is AgentStats => !!a);
    if (lenders.length === 1) return fromAgent(lenders[0]);
    if (lenders.length > 1) {
      const names = lenders.map((a) => a.label || shortAddress(a.address));
      return makeActor(`${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`, "lender", lenders[0].address);
    }
    return makeActor("Lenders", "lender");
  }

  const matched = byAddress(lower(e.agent)) ?? byUaid(str(e.agentUaid));
  if (matched) return fromAgent(matched);

  if (e.type === "AgentRegistered") {
    const evm = lower(e.evmAddress);
    const registered = byAddress(evm) ?? byUaid(str(e.agentUaid));
    if (registered) return fromAgent(registered);
    const name = str(e.name);
    if (name) return makeActor(name, isRole(e.role) ? e.role : "worker", evm);
  }

  const inferred = INFERRED[e.type];
  if (inferred) return makeActor(inferred.name, inferred.role, lower(e.agent));

  // LLM audit events carry the run's role even when the agent is not in /agents.
  if ((e.type === "LlmToolCall" || e.type === "LlmRunFinished") && isRole(e.role)) return makeActor(cap(e.role), e.role);

  // Overdue / Defaulted / Disputed and unknown types land here: the MCP server is the actor unless `agent` resolved above.
  return makeActor(MCP_NAME, "mcp");
}

const HASH = /^0x[0-9a-f]{64}$/i;

/** Human label of a receivable: the PO reference when known, else the short id (an on-chain hash is unreadable), else generic. */
const invoiceRef = (e: AuditEvent, refs?: Refs): string => {
  const id = str(e.id);
  if (!id) return "an invoice";
  return `invoice ${refs?.get(id.toLowerCase()) ?? shortAddress(id)}`;
};

/**
 * Links invoice documents to receivables: ReceivableUploaded.documentKeccak == InvoiceDocumentStored.keccak256.
 * `refs` maps lowercase receivable id -> human PO reference; `docIds` maps an InvoiceDocumentStored event (by seq) to its receivable id.
 * A receivableRef that is itself a hash is never a label; if it equals a known receivable id it is only the link.
 */
function linkDocuments(events: AuditEvent[]): { refs: Map<string, string>; docIds: Map<AuditEvent, string> } {
  const refs = new Map<string, string>();
  const docIds = new Map<AuditEvent, string>();
  const byKeccak = new Map<string, string>();
  const known = new Map<string, string>(); // lowercase receivable id -> id as recorded
  for (const e of events) {
    const id = str(e.id);
    if (e.type === "ReceivableUploaded" && id) {
      known.set(id.toLowerCase(), id);
      const keccak = lower(e.documentKeccak);
      if (keccak && !byKeccak.has(keccak)) byKeccak.set(keccak, id);
    }
  }
  for (const e of events) {
    if (e.type !== "InvoiceDocumentStored") continue;
    const ref = str(e.receivableRef);
    const keccak = lower(e.keccak256);
    const id = (keccak ? byKeccak.get(keccak) : undefined) ?? (ref ? known.get(ref.toLowerCase()) : undefined);
    if (id) {
      docIds.set(e, id);
      if (ref && !HASH.test(ref) && !refs.has(id.toLowerCase())) refs.set(id.toLowerCase(), ref);
    }
  }
  return { refs, docIds };
}

/** Formatted amount, or undefined when the event has none (or it is not a base-unit decimal string). */
const money = (e: AuditEvent): string | undefined => {
  const f = formatUsdc(typeof e.amount === "string" ? e.amount : undefined);
  return f === "—" ? undefined : f;
};

const merchantOf = (e: AuditEvent): string => {
  const m = str(e.merchant);
  return m ? shortAddress(m) : "a merchant";
};

const guardrail = (e: AuditEvent): string => {
  const code = str(e.code);
  return `${code ? humanizeCode(code) : "Rejected"} · the guardrail worked`;
};

type Refs = ReadonlyMap<string, string>;

const TEXT: Record<string, (e: AuditEvent, refs?: Refs) => Text> = {
  AgentRegistered: (e) => ({
    sentence: "joined CashETH",
    detail: `Identity registered on Hedera${typeof e.level === "number" && Number.isFinite(e.level) ? ` · trust level ${e.level}` : ""}`,
    tone: "info",
  }),
  InvoiceDocumentStored: () => ({ sentence: "stored an invoice document", detail: "Only its fingerprint goes on Hedera", tone: "info" }),
  ReceivableUploaded: (e, refs) => {
    const amount = money(e);
    return { sentence: `uploaded ${invoiceRef(e, refs)}${amount ? ` for ${amount}` : ""}`, detail: "Waiting for the buyer to confirm", tone: "ok" };
  },
  ReceivableConfirmed: (e, refs) => ({ sentence: `confirmed it owes ${money(e) ?? "money"} on ${invoiceRef(e, refs)}`, detail: "Signed by the buyer's agent", tone: "ok" }),
  ReceivableRejected: (e, refs) => ({ sentence: `was refused for ${invoiceRef(e, refs)}`, detail: guardrail(e), tone: "blocked" }),
  NftMinted: (e, refs) => ({ sentence: `turned ${invoiceRef(e, refs)} into an on-chain asset`, detail: "Receivable NFT minted on Hedera", tone: "ok" }),
  StrategyShipped: () => ({ sentence: "offered capital to lend", detail: "Lending strategy published on 1inch Aqua", tone: "info" }),
  StrategyDocked: () => ({ sentence: "withdrew its lending offer", detail: "Capital returned to the lender", tone: "info" }),
  FacilityFunded: (e, refs) => ({ sentence: `lent ${money(e) ?? "money"} against ${invoiceRef(e, refs)}`, detail: "Cheapest offers filled first", tone: "ok" }),
  BudgetsSet: () => ({ sentence: "set spending budgets for its workers", detail: "Each worker gets a hard limit", tone: "info" }),
  SpendReserved: (e) => ({ sentence: `set aside ${money(e) ?? "money"} to pay ${merchantOf(e)}`, detail: "Reserved inside its budget", tone: "info" }),
  SpendCommitted: (e) => ({ sentence: `paid ${money(e) ?? "money"} to ${merchantOf(e)}`, detail: "x402 payment settled on Hedera", tone: "ok" }),
  SpendReleased: (e) => {
    const amount = money(e);
    return { sentence: `cancelled a ${amount ? `${amount} ` : ""}reservation`, detail: "Unused money went back to the budget", tone: "info" };
  },
  SpendRejected: (e) => ({ sentence: `was blocked from spending ${money(e) ?? "money"}`, detail: guardrail(e), tone: "blocked" }),
  Repaid: (e, refs) => ({ sentence: `repaid ${money(e) ?? "money"} on ${invoiceRef(e, refs)}`, detail: "Lenders were paid back first", tone: "ok" }),
  Overdue: (e, refs) => ({ sentence: `flagged ${invoiceRef(e, refs)} as overdue`, detail: "Set on time by Hedera's schedule service", tone: "warn" }),
  Defaulted: (e, refs) => ({ sentence: `flagged ${invoiceRef(e, refs)} as defaulted`, detail: "Lenders' losses are now recorded", tone: "blocked" }),
  Disputed: (e, refs) => ({ sentence: `marked ${invoiceRef(e, refs)} as disputed`, detail: "Financing paused while it is resolved", tone: "warn" }),
  LlmToolCall: (e) => {
    const outcome = str(e.outcome);
    return {
      sentence: `asked the MCP server to ${str(e.tool) ?? "run a tool"}`,
      detail: `Outcome: ${outcome ?? "unknown"}`,
      tone: outcome && outcome !== "ok" ? "blocked" : "info",
    };
  },
  LlmRunFinished: (e) => ({ sentence: "finished its task", detail: `Status: ${str(e.status) ?? "unknown"}`, tone: "info" }),
};

const WITH_AMOUNT = new Set(["FacilityFunded", "SpendCommitted", "Repaid", "ReceivableUploaded", "ReceivableConfirmed", "SpendReserved", "SpendRejected"]);

function proofOf(e: AuditEvent, hcsTopicId: string): string | undefined {
  const hashscan = str(e.hashscan);
  if (hashscan) return hashscan;
  if (typeof e.hcsSeq === "number" && Number.isFinite(e.hcsSeq)) return `https://hashscan.io/testnet/topic/${hcsTopicId}/message/${e.hcsSeq}`;
  return undefined;
}

export function narrate(e: AuditEvent, agents: AgentStats[], hcsTopicId: string, refs?: Refs): Narrated {
  const text = TEXT[e.type]?.(e, refs) ?? { sentence: `recorded ${e.type}`, detail: "", tone: "info" as const };
  const proofUrl = proofOf(e, hcsTopicId);
  const id = str(e.id);
  const own = e.type === "InvoiceDocumentStored" ? str(e.receivableRef) : undefined;
  const ref = own && !HASH.test(own) ? own : id ? refs?.get(id.toLowerCase()) : undefined;
  const amount = WITH_AMOUNT.has(e.type) && typeof e.amount === "string" && /^\d+$/.test(e.amount) ? e.amount : undefined;
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    ...(id ? { id } : {}),
    ...(ref ? { ref } : {}),
    ...(str(e.spendId) ? { spendId: str(e.spendId) } : {}),
    actor: resolveActor(e, agents),
    ...text,
    ...(amount ? { amount } : {}),
    ...(proofUrl ? { proofUrl } : {}),
  };
}

/**
 * Narrates every event, newest first (seq descending). Invoice documents are joined to their receivable, so every
 * item of one invoice shares its PO label and an InvoiceDocumentStored item carries the receivable's `id`.
 */
export function narrateAll(events: AuditEvent[], agents: AgentStats[], hcsTopicId: string): Narrated[] {
  const { refs, docIds } = linkDocuments(events);
  return events
    .map((e) => {
      const n = narrate(e, agents, hcsTopicId, refs);
      const joined = docIds.get(e);
      if (!joined) return n;
      const ref = n.ref ?? refs.get(joined.toLowerCase());
      return { ...n, id: joined, ...(ref ? { ref } : {}) };
    })
    .sort((a, b) => b.seq - a.seq);
}
