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

export function resolveActor(e: AuditEvent, agents: AgentStats[]): Actor {
  const byAddress = (addr: string | undefined) => (addr ? agents.find((a) => a.address.toLowerCase() === addr) : undefined);
  const byUaid = (uaid: string | undefined) => (uaid ? agents.find((a) => a.uaid === uaid) : undefined);

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

/** Short form of a receivable id (an on-chain 32-byte hash is unreadable in a sentence). */
const invoiceRef = (e: AuditEvent): string => {
  const id = str(e.id);
  return id ? `invoice ${shortAddress(id)}` : "an invoice";
};

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

const TEXT: Record<string, (e: AuditEvent) => Text> = {
  AgentRegistered: (e) => ({
    sentence: "joined CashETH",
    detail: `Identity registered on Hedera${typeof e.level === "number" && Number.isFinite(e.level) ? ` · trust level ${e.level}` : ""}`,
    tone: "info",
  }),
  InvoiceDocumentStored: () => ({ sentence: "stored an invoice document", detail: "Only its fingerprint goes on Hedera", tone: "info" }),
  ReceivableUploaded: (e) => {
    const amount = money(e);
    return { sentence: `uploaded ${invoiceRef(e)}${amount ? ` for ${amount}` : ""}`, detail: "Waiting for the buyer to confirm", tone: "ok" };
  },
  ReceivableConfirmed: (e) => ({ sentence: `confirmed it owes ${money(e) ?? "money"} on ${invoiceRef(e)}`, detail: "Signed by the buyer's agent", tone: "ok" }),
  ReceivableRejected: (e) => ({ sentence: `was refused for ${invoiceRef(e)}`, detail: guardrail(e), tone: "blocked" }),
  NftMinted: (e) => ({ sentence: `turned ${invoiceRef(e)} into an on-chain asset`, detail: "Receivable NFT minted on Hedera", tone: "ok" }),
  StrategyShipped: () => ({ sentence: "offered capital to lend", detail: "Lending strategy published on 1inch Aqua", tone: "info" }),
  StrategyDocked: () => ({ sentence: "withdrew its lending offer", detail: "Capital returned to the lender", tone: "info" }),
  FacilityFunded: (e) => ({ sentence: `lent ${money(e) ?? "money"} against ${invoiceRef(e)}`, detail: "Cheapest offers filled first", tone: "ok" }),
  BudgetsSet: () => ({ sentence: "set spending budgets for its workers", detail: "Each worker gets a hard limit", tone: "info" }),
  SpendReserved: (e) => ({ sentence: `set aside ${money(e) ?? "money"} to pay ${merchantOf(e)}`, detail: "Reserved inside its budget", tone: "info" }),
  SpendCommitted: (e) => ({ sentence: `paid ${money(e) ?? "money"} to ${merchantOf(e)}`, detail: "x402 payment settled on Hedera", tone: "ok" }),
  SpendReleased: (e) => {
    const amount = money(e);
    return { sentence: `cancelled a ${amount ? `${amount} ` : ""}reservation`, detail: "Unused money went back to the budget", tone: "info" };
  },
  SpendRejected: (e) => ({ sentence: `was blocked from spending ${money(e) ?? "money"}`, detail: guardrail(e), tone: "blocked" }),
  Repaid: (e) => ({ sentence: `repaid ${money(e) ?? "money"} on ${invoiceRef(e)}`, detail: "Lenders were paid back first", tone: "ok" }),
  Overdue: (e) => ({ sentence: `flagged ${invoiceRef(e)} as overdue`, detail: "Set on time by Hedera's schedule service", tone: "warn" }),
  Defaulted: (e) => ({ sentence: `flagged ${invoiceRef(e)} as defaulted`, detail: "Lenders' losses are now recorded", tone: "blocked" }),
  Disputed: (e) => ({ sentence: `marked ${invoiceRef(e)} as disputed`, detail: "Financing paused while it is resolved", tone: "warn" }),
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

export function narrate(e: AuditEvent, agents: AgentStats[], hcsTopicId: string): Narrated {
  const text = TEXT[e.type]?.(e) ?? { sentence: `recorded ${e.type}`, detail: "", tone: "info" as const };
  const proofUrl = proofOf(e, hcsTopicId);
  const amount = WITH_AMOUNT.has(e.type) && typeof e.amount === "string" && /^\d+$/.test(e.amount) ? e.amount : undefined;
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    ...(str(e.id) ? { id: str(e.id) } : {}),
    ...(str(e.spendId) ? { spendId: str(e.spendId) } : {}),
    actor: resolveActor(e, agents),
    ...text,
    ...(amount ? { amount } : {}),
    ...(proofUrl ? { proofUrl } : {}),
  };
}

/** Narrates every event, newest first (seq descending). */
export function narrateAll(events: AuditEvent[], agents: AgentStats[], hcsTopicId: string): Narrated[] {
  return events.map((e) => narrate(e, agents, hcsTopicId)).sort((a, b) => b.seq - a.seq);
}
