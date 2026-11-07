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
  /** Risk slab and the APR the agent would pay as a seller now. */
  slab: string;
  aprBps: number;
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
  slabs: string[];
  sellers: Address[];
  capital: string;
  lent: string;
  idle: string;
  baseFees: string;
  creditFees: string;
  baseApr: number;
  creditApr: number;
  blendedApr: number;
  extraEarned: string;
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
  /** `undefined` for an id the server has never seen (HTTP 404). */
  receivable(id: Hex): Promise<ReceivableDetails | undefined>;
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
    async receivable(id) {
      const res = await fetchImpl(new URL(`/receivables/${id}`, baseUrl));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GET /receivables/${id} failed with HTTP ${res.status}`);
      return (await res.json()) as ReceivableDetails;
    },
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
