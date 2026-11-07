/**
 * Typed client for the CashETH read API (docs/API.md section 4), served by apps/mcp-server. No auth.
 * Amounts are USDC base-unit decimal strings.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4030";
export const HCS_TOPIC_ID = process.env.NEXT_PUBLIC_HCS_TOPIC_ID || "0.0.11338927";

export type KnownAuditEventType =
  | "AgentRegistered"
  | "ReceivableUploaded"
  | "ReceivableConfirmed"
  | "ReceivableRejected"
  | "NftMinted"
  | "StrategyShipped"
  | "StrategyDocked"
  | "FacilityFunded"
  | "BudgetsSet"
  | "SpendReserved"
  | "SpendCommitted"
  | "SpendReleased"
  | "SpendRejected"
  | "Repaid"
  | "Overdue"
  | "Defaulted"
  | "Disputed"
  | "InvoiceDocumentStored";

/** Known types plus any string, so events of a type this UI has not heard of still type-check. */
export type AuditEventType = KnownAuditEventType | (string & {});

export type AuditEvent = {
  v: 1;
  type: AuditEventType;
  seq: number; // 1-based, local
  prevSeq: number; // seq - 1
  ts: string; // ISO time
  id?: string; // receivable id
  spendId?: string;
  agent?: string; // caller EVM address
  agentUaid?: string; // caller UAID when the token's sub is one
  jti?: string; // access token id of the call
  amount?: string; // units
  asset?: string; // USDC token id
  merchant?: string;
  txId?: string; // Hedera transaction id
  txHash?: string; // EVM transaction hash
  hashscan?: string; // HashScan link of the main transaction
  code?: string; // rejection code
  hcsSeq?: number; // HCS sequence number of the same message on the audit topic
  hcsTxId?: string;
  hcsError?: string; // set instead of hcsSeq when the HCS publish failed (best-effort)
  [k: string]: unknown; // type-specific fields (decision, fills, workers, strategyHash, ...)
};

/** Risk slab of a seller's score (low 700+, medium 600-699, high 500-599; `none` below 500). */
export type Slab = "low" | "medium" | "high" | "none";

export type AgentStats = {
  address: string;
  uaid: string;
  role: "seller" | "buyer" | "worker" | "lender";
  label: string;
  level: number; // KYA level
  score: number; // scoreReceivable on the agent's own reputation (base score, zero tenor)
  slab: Slab; // risk slab of the score
  aprBps: number; // the APR the agent would pay as a seller now (0 when not financeable)
  onTimePct: number; // on-time / (on-time + late + defaults) x 100; 0 without history
  receivablesFunded: number; // receivables (as seller or buyer) that reached Financed
  receivablesRepaid: number;
  receivablesDefaulted: number;
  avgDaysToRepay: number; // Financed -> Repaid, days, 1 decimal; 0 if none
  spendByMerchant: Record<string, string>; // merchant EVM address -> committed units
  lenderReturnPct: number; // lenders: (creditFees + baseFees) / capital x 100; others 0
};

export type LenderYield = {
  address: string;
  label: string;
  slabs: Exclude<Slab, "none">[]; // risk slabs its open credit strategies fund, safest first
  sellers: string[]; // sellers its credit strategies are limited to; empty = any seller in its slabs
  capital: string; // idle + lent
  lent: string; // sum PositionOpened.principal - sum LenderPaid.principal
  idle: string; // wallet USDC balance
  baseFees: string; // Aqua Pushed into the lender's strategies x base feeBps
  creditFees: string; // sum LenderPaid.fee
  baseApr: number; // baseFees / base strategy balance, annualised since its first swap
  creditApr: number; // principal-weighted APR of its credit positions (each at its seller's own rate)
  blendedApr: number; // (baseApr x idle + creditApr x lent) / capital
  extraEarned: string; // credit fees minus what the same principal would have earned farming over the same time
  strategies: { credit?: string; base?: string }; // open strategy hashes
};

export type Health = { ok: true; resource: string; authorizationServer: string; events: number };

export type ReceivableState = "Pending" | "Confirmed" | "Financed" | "Repaid" | "Overdue" | "Defaulted" | "Cancelled";

export type ReceivableDetails = {
  id: string;
  state: ReceivableState;
  seller: string;
  buyer: string;
  amount: string; // face value, units
  dueDate: number; // unix seconds
  funded: string; // facility funded amount
  debt: string; // principal + fee still owed to lenders
  positions: { maker: string; principal: string; aprBps: number; fee: string }[];
  evidence: { label: string; url: string }[];
  document?: { keccak: string; verified: boolean };
};

/** Non-2xx response from the read API (`{ code, message }` body when present). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  const root = baseUrl.replace(/\/+$/, "");

  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${root}${path}`, { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(res.status, body.message ?? (res.statusText || `HTTP ${res.status}`));
    }
    return (await res.json()) as T;
  }

  return {
    health: () => get<Health>("/health"),
    events: () => get<AuditEvent[]>("/events"),
    agents: () => get<AgentStats[]>("/agents"),
    lenders: () => get<LenderYield[]>("/lenders"),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
