/**
 * The orchestrator's dependency object. Every external system sits behind a narrow port so the tool logic can be
 * unit-tested with in-memory fakes; `src/live.ts` implements the ports with viem, the Hiero SDK, the mirror node,
 * `@casheth/aqua` and `@casheth/hedera`.
 */
import type { AquaAddresses, CreditArgs, LenderStrategy, Plan, ShipResult, SolveInput } from "@casheth/aqua";
import type { EventStore, IdempotencyLedger } from "@casheth/engine";
import type { X402Result } from "@casheth/hedera";
import type { Address, Hex } from "viem";
import type { PendingStore } from "./pending.js";
import type { SpendWalletPort } from "./spendWallets.js";

/** One transaction the server cannot sign itself, returned for the agent to sign and send in order. */
export type Calldata = { to: Address; data: Hex; description: string };

export type KyaAgent = {
  uaidHash: Hex;
  ownerGroup: Hex;
  role: number;
  level: number;
  expiresAt: bigint;
  revoked: boolean;
  mandateHash: Hex;
};

export type Reputation = { onTime: number; late: number; defaults: number };

/** `IReceivableRegistry.Receivable` plus nothing else; `state` is the `State` enum index. */
export type ReceivableView = {
  seller: Address;
  buyer: Address;
  currency: Address;
  amount: bigint;
  dueDate: bigint;
  detailsCommitment: Hex;
  state: number;
  registeredAt: bigint;
};

export type FacilityInfoView = {
  seller: Address;
  buyer: Address;
  receivableAmount: bigint;
  dueDate: bigint;
  funded: bigint;
  committed: bigint;
  reserved: bigint;
  /** 0 none, 1 active, 2 frozen, 3 closed. */
  status: number;
};

export type PositionView = { principal: bigint; aprBps: number; start: bigint; paidPrincipal: bigint; paidFee: bigint };

export type BudgetView = {
  alloc: bigint;
  spent: bigint;
  reserved: bigint;
  maxPerTx: bigint;
  maxDaily: bigint;
  dailySpent: bigint;
  dayStart: bigint;
};

export type ReservationView = {
  id: Hex;
  worker: Address;
  spendWallet: Address;
  merchant: Address;
  amount: bigint;
  expiry: bigint;
  /** 0 none, 1 open, 2 committed, 3 released. */
  status: number;
  txIdHash: Hex;
};

export type ChainAddresses = {
  chainId: number;
  kyaRegistry: Address;
  receivableRegistry: Address;
  creditFacility: Address;
  repaymentRouter: Address;
  usdc: Address;
};

/** Who signs a server-sent transaction: the coordinator, the KYA issuer, or an agent whose key the server holds. */
export type Signer = "coordinator" | "issuer" | { agent: Address };

/** Contract reads and server-signed writes on Hedera EVM. */
export interface ChainPort {
  /** Read from `deployments/testnet/addresses.json` on every call; throws `NOT_DEPLOYED` for a missing contract. */
  addresses(): ChainAddresses;
  latestTimestamp(): Promise<bigint>;
  kyaAgent(account: Address): Promise<KyaAgent>;
  reputation(account: Address): Promise<Reputation>;
  receivableState(id: Hex): Promise<number>;
  receivable(id: Hex): Promise<ReceivableView>;
  buyerNonce(buyer: Address): Promise<bigint>;
  facilityInfo(id: Hex): Promise<FacilityInfoView>;
  makers(id: Hex): Promise<Address[]>;
  position(id: Hex, maker: Address): Promise<PositionView>;
  available(id: Hex): Promise<bigint>;
  budget(id: Hex, worker: Address): Promise<BudgetView>;
  merchants(id: Hex, worker: Address): Promise<Address[]>;
  reservation(spendId: Hex): Promise<ReservationView>;
  openReservationOf(spendWallet: Address): Promise<Hex>;
  paused(): Promise<boolean>;
  lenderDue(id: Hex): Promise<bigint>;
  dueOf(id: Hex, maker: Address): Promise<{ principal: bigint; fee: bigint }>;
  usdcBalance(account: Address): Promise<bigint>;
  /**
   * Simulates, then sends `call` from `from` and waits for the receipt. A revert throws
   * `ToolError(<custom error name>)` (the contracts revert with the shared error-code names).
   */
  send(from: Signer, call: Calldata): Promise<{ txHash: Hex }>;
  /** True when the server may sign as `agent` (its key is configured and the in-process flag for its role is on). */
  holdsKey(agent: Address): boolean;
}

/** What `fund_agents` ships for one lender: the credit (boost) strategy and optionally the base-yield strategy. */
export type FundPlan = {
  args: CreditArgs;
  creditUsdc: bigint;
  base?: { usdc: bigint; tUsdt: bigint; feeBps: number };
  salt: bigint;
};

export type FundResult =
  | { mode: "shipped"; credit: ShipResult; base?: ShipResult }
  | { mode: "calldata"; calls: Calldata[]; credit: { strategyHash: Hex }; base?: { strategyHash: Hex } };

/** Aqua discovery, the solver and lender-side ship/dock. */
export interface AquaPort {
  addresses(): AquaAddresses;
  discover(): Promise<{ strategies: LenderStrategy[]; skipped: { maker: Address; strategyHash: Hex; reason: string }[] }>;
  solve(input: SolveInput): Promise<Plan>;
  /** Ships with the lender's in-process key when `inProcess`, else returns the approve + ship calldatas. */
  fund(lender: Address, plan: FundPlan, inProcess: boolean): Promise<FundResult>;
  /** Docks with the lender's in-process key when `inProcess`, else returns the dock calldata. */
  dock(
    lender: Address,
    p: { strategyHash: Hex; tokens: Address[] },
    inProcess: boolean,
  ): Promise<{ mode: "sent"; txHash: Hex } | { mode: "calldata"; calls: Calldata[] }>;
}

/** Token transfers of a (partially signed) Hedera transfer transaction, decoded from its bytes. */
export type TransferSummary = {
  /** Transaction id payer (the fee payer for x402 `exact`). */
  payerAccountId?: string;
  tokenTransfers: { tokenId: string; accountId: string; amount: bigint }[];
  hbarTransfers: { accountId: string; amount: bigint }[];
};

export type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  extra?: Record<string, unknown>;
};

/** x402 buyer side for the co-signed spend wallets. */
export interface X402Port {
  /** Hedera account id (`0.0.x`) behind an EVM address (mirror node). */
  accountIdOf(evm: Address): Promise<string>;
  decodeTransfer(txBase64: string): TransferSummary;
  /** Adds the policy co-signer's signature. Only called after the policy approved the payment. */
  cosignerSign(txBase64: string): Promise<string>;
  /**
   * Pays `url` from `spendWalletId` with the worker's key (held in process) and the given co-sign callback.
   * Throws `ToolError("WORKER_KEY_NOT_HELD")` when the server does not hold the worker's key.
   */
  pay(p: {
    worker: Address;
    spendWalletId: string;
    url: string;
    cosign: (txBase64: string, requirements: PaymentRequirements) => Promise<string>;
  }): Promise<X402Result>;
}

export interface HcsPort {
  topicId: string | undefined;
  publish(message: Record<string, unknown> & { v: 1; type: string; prevSeq: number; ts: string }): Promise<{
    sequenceNumber: number;
    txId: string;
  }>;
}

export interface NftPort {
  tokenId: string | undefined;
  mint(p: { id: Hex; hcsSeq: number }): Promise<{ serial: number; txId: string }>;
}

export type Explanation = { text: string; source: "anthropic" | "template"; model?: string };

export interface ExplainerPort {
  /** LLM explanation of a deterministic decision; `undefined` when no model is configured. */
  explain(p: { decision: Record<string, unknown>; rules: string[] }): Promise<Explanation | undefined>;
}

export type AgentRoleName = "seller" | "buyer" | "worker" | "lender";

/** R14: `GET /agents` row. USDC amounts are 6-decimal unit strings. */
export type AgentStats = {
  address: Address;
  uaid: string;
  role: AgentRoleName;
  label: string;
  level: number;
  score: number;
  tier: "low" | "medium" | "high" | "none";
  onTimePct: number;
  receivablesFunded: number;
  receivablesRepaid: number;
  receivablesDefaulted: number;
  avgDaysToRepay: number;
  spendByMerchant: Record<string, string>;
  lenderReturnPct: number;
};

/** R14: `GET /lenders` row. USDC amounts are 6-decimal unit strings, APRs percent numbers. */
export type LenderYield = {
  address: Address;
  label: string;
  tier: "low" | "medium" | "high" | "custom" | "none";
  capital: string;
  lent: string;
  idle: string;
  baseFees: string;
  creditFees: string;
  baseApr: number;
  boostApr: number;
  blendedApr: number;
  strategies: { credit?: Hex; base?: Hex };
};

/** Agent and lender statistics (`packages/stats` replaces the basic provider in Task 6.5). */
export interface StatsProvider {
  listAgents(): Promise<AgentStats[]>;
  agentStats(address: Address): Promise<AgentStats>;
  listLenders(): Promise<LenderYield[]>;
  lenderYield(address: Address): Promise<LenderYield>;
}

/** One contract log with its consensus time (mirror node `contracts/{address}/results/logs`). */
export type RawLog = { address: Address; topics: Hex[]; data: Hex; timestamp: number; txHash: Hex };

/** Every log a contract emitted, oldest first. */
export interface LogSource {
  logs(address: Address): Promise<RawLog[]>;
}

/** Known agents (demo accounts, `register_agent` registrations) with their label and HCS-14 UAID. */
export type AgentDirectoryEntry = { address: Address; label: string; role: AgentRoleName; uaid: string };

/** Inputs `register_agent` needs that are not contract calls: the HCS-14 UAID. */
export interface IdentityPort {
  uaid(p: { evmAddress: Address; accountId: string; name: string; role: AgentRoleName }): Promise<string>;
}

export type OrchestratorConfig = {
  /** CAIP-2 x402 network (`hedera:testnet`). */
  x402Network: string;
  usdcTokenId: string;
  /** Hashscan base for links (testnet). */
  explorer: "testnet";
  /** Merchant account id -> URL origins `pay_x402` may fetch for a reservation to that merchant. */
  merchantOrigins: Record<string, string[]>;
};

export interface Orchestrator {
  chain: ChainPort;
  aqua: AquaPort;
  x402: X402Port;
  hcs: HcsPort;
  nft: NftPort;
  explainer: ExplainerPort;
  stats: StatsProvider;
  identity: IdentityPort;
  spendWallets: SpendWalletPort;
  events: EventStore;
  idempotency: IdempotencyLedger;
  pending: PendingStore;
  config: OrchestratorConfig;
  /** Unix seconds (wall clock; on-chain checks read `chain.latestTimestamp`). */
  now(): bigint;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The authenticated MCP caller, from the access token claims (keyed on `agent`, never on `sub`). */
export type Caller = {
  agent: Address;
  role: number;
  level: number;
  ownerGroup: Hex;
  scopes: string[];
  sub: string;
  jti: string;
  clientId?: string;
};
