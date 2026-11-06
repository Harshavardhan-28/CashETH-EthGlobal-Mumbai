/** Client for the MCP server's unauthenticated read API (docs/API.md section 4): the demo's proof and its tables. */
import type { Address, Hex } from "viem";

export interface AuditEvent {
  type: string;
  seq: number;
  id?: string;
  worker?: string;
  code?: string;
  /** The Aqua strategy a `StrategyShipped` event is about. */
  strategyHash?: string;
  /** EVM hash of the main transaction of the event. */
  txHash?: string;
  /** Hedera transaction id of the NFT mint (`NftMinted`). */
  txId?: string;
  /** Hedera transaction id of the HCS message that carries this event. */
  hcsTxId?: string;
  [field: string]: unknown;
}

export interface AgentStats {
  address: Address;
  label: string;
  role: string;
  level: number;
  score: number;
  tier: string;
  onTimePct: number;
  receivablesFunded: number;
  receivablesRepaid: number;
  receivablesDefaulted: number;
  avgDaysToRepay: number;
  lenderReturnPct: number;
}

export interface LenderYield {
  address: Address;
  label: string;
  tier: string;
  capital: string;
  lent: string;
  idle: string;
  baseFees: string;
  creditFees: string;
  baseApr: number;
  boostApr: number;
  blendedApr: number;
}

export interface ReceivableDetails {
  id: Hex;
  state: string;
  amount: string;
  funded: string;
  debt: string;
  positions: { maker: Address; principal: string; aprBps: number; fee: string }[];
}

export interface ReadApi {
  events(): Promise<AuditEvent[]>;
  agents(): Promise<AgentStats[]>;
  lenders(): Promise<LenderYield[]>;
  receivable(id: Hex): Promise<ReceivableDetails>;
}

export function createReadApi(baseUrl: string, fetchImpl: typeof fetch = fetch): ReadApi {
  const get = async <T>(path: string): Promise<T> => {
    const url = new URL(path, baseUrl);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`GET ${url.href} failed with HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    events: () => get("/events"),
    agents: () => get("/agents"),
    lenders: () => get("/lenders"),
    receivable: (id) => get(`/receivables/${id}`),
  };
}

export interface EventMatch {
  type: string;
  id?: string;
  code?: string;
  worker?: string;
  strategyHash?: string;
}

/** The latest event that matches every given field (addresses compare case-insensitively). */
export function findEvent(events: AuditEvent[], match: EventMatch): AuditEvent | undefined {
  const same = (a: string | undefined, b: string | undefined) => a?.toLowerCase() === b?.toLowerCase();
  return [...events].reverse().find(
    (e) =>
      e.type === match.type &&
      (match.id === undefined || same(e.id, match.id)) &&
      (match.code === undefined || e.code === match.code) &&
      (match.worker === undefined || same(e.worker, match.worker)) &&
      (match.strategyHash === undefined || same(e.strategyHash, match.strategyHash)),
  );
}
