/**
 * Client for the CashETH read API (docs/API.md section 4), served by apps/mcp-server. No auth.
 * Types are copied from that document; amounts are USDC base-unit decimal strings.
 */

export const DEFAULT_API_URL = "http://localhost:4030";

export type AuditEventType =
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
  | "Disputed";

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
  hcsSeq?: number; // HCS sequence number of the same message on HCS_AUDIT_TOPIC_ID
  hcsTxId?: string;
  hcsError?: string; // set instead of hcsSeq when the HCS publish failed (best-effort)
  [k: string]: unknown; // type-specific fields (decision, fills, workers, strategyHash, ...)
};

export type AgentStats = {
  address: string;
  uaid: string;
  role: "seller" | "buyer" | "worker" | "lender";
  label: string;
  level: number; // KYA level
  score: number; // scoreReceivable on the agent's own reputation (base score, zero tenor)
  tier: "low" | "medium" | "high" | "none"; // safest lender tier whose seller thresholds the agent meets
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
  tier: "low" | "medium" | "high" | "custom" | "none"; // from the cheapest open credit strategy's aprBps
  capital: string; // idle + lent
  lent: string; // Σ PositionOpened.principal - Σ LenderPaid.principal
  idle: string; // wallet USDC balance
  baseFees: string; // Σ Aqua Pushed (USDC/tUSDT) into the lender's strategies x base feeBps
  creditFees: string; // Σ LenderPaid.fee
  baseApr: number; // baseFees / base strategy balance, annualised since its first swap
  boostApr: number; // credit strategy aprBps / 100
  blendedApr: number; // (baseApr x idle + boostApr x lent) / capital
  strategies: { credit?: string; base?: string }; // open strategy hashes
};

export type ReceivableDetails = {
  id: string;
  state: "Pending" | "Confirmed" | "Financed" | "Repaid" | "Overdue" | "Defaulted" | "Cancelled";
  seller: string;
  buyer: string;
  amount: string; // face value, units
  dueDate: number; // unix seconds
  funded: string; // facility funded amount
  debt: string; // RepaymentRouter.lenderDue (principal + fee still owed to lenders)
  positions: Array<{ maker: string; principal: string; aprBps: number; fee: string /* paid + currently due */ }>;
  evidence: Array<{ label: string; url: string }>; // HashScan links of every event for this id (tx, HCS message, NFT)
};

export type Health = { ok: true; resource: string; authorizationServer: string; events: number };

/** Error body of the read API: `{ code, message }` with 400, 404, 503 or 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApiClient(baseUrl: string = DEFAULT_API_URL, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  const root = baseUrl.replace(/\/+$/, "");

  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${root}${path}`, { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new ApiError(res.status, body.code ?? "UNKNOWN", body.message ?? res.statusText);
    }
    return (await res.json()) as T;
  }

  return {
    health: () => get<Health>("/health"),
    events: () => get<AuditEvent[]>("/events"),
    agents: () => get<AgentStats[]>("/agents"),
    lenders: () => get<LenderYield[]>("/lenders"),
    receivable: (id: string) => get<ReceivableDetails>(`/receivables/${encodeURIComponent(id)}`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The app's client: `NEXT_PUBLIC_API_URL` (inlined at build time) or the local MCP server. */
export const api = createApiClient(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL);
