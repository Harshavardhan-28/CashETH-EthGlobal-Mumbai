/**
 * Lender agent: ships a credit strategy for the risk slabs it funds (and optionally a base-yield one) through
 * `fund_agents`. It chooses risk, not price: every fill pays the seller's own rate, set on chain from its score. When the MCP server
 * holds the lender key it ships itself; otherwise it returns the exact-amount approvals and ship calls, and the
 * lender signs and sends them from its own wallet.
 */
import type { RiskSlab } from "@casheth/aqua";
import type { Address, Hex } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";
import { sendInOrder, type CallSender, type Calldata } from "./sendCalls.js";

export interface ShipParams {
  /** Risk slabs funded: low (6-8% APR), medium (8-11%), high (11-14%). */
  slabs: RiskSlab[];
  /** At most 3 sellers it backs, still only within its slabs. */
  sellers?: Address[];
  /** USDC base units (6 decimals) committed to the credit strategy. */
  creditUsdc: bigint;
  /** Largest exposure to one buyer, USDC base units; the server's default is 5 USDC. */
  maxPerBuyer?: bigint;
  /** Base-yield strategy amounts; give both or neither. */
  baseUsdc?: bigint;
  baseTusdt?: bigint;
  /**
   * The default idempotency key is derived from the strategy (slabs, amounts, sellers) and this attempt id
   * (default "1"), so retrying a ship replays the first result; use a new attempt to ship an identical strategy again.
   */
  attempt?: string;
  /** Overrides the derived key. */
  idempotencyKey?: string;
}

/** Same strategy parameters and attempt, same key. */
function shipKey(p: ShipParams): string {
  const sellers = (p.sellers ?? []).map((s) => s.toLowerCase()).sort().join(",");
  const slabs = [...p.slabs].sort().join(",");
  return idempotencyKey("fund", slabs, p.creditUsdc.toString(), sellers, String(p.baseUsdc ?? ""), String(p.baseTusdt ?? ""), p.attempt ?? "1");
}

type Strategies = { credit: Hex; base?: Hex };
type Shipped = { mode: "shipped"; slabs: RiskSlab[]; credit: Record<string, unknown>; base?: Record<string, unknown> };
type CalldataResult = { mode: "calldata"; slabs: RiskSlab[]; calls: Calldata[]; strategies: Strategies };
export type ShipOutcome = Shipped | { mode: "sent"; slabs: RiskSlab[]; strategies: Strategies; txHashes: Hex[] };

function fundArguments(p: ShipParams): Record<string, unknown> {
  if ((p.baseUsdc === undefined) !== (p.baseTusdt === undefined)) {
    throw new Error("a base-yield strategy needs both baseUsdc and baseTusdt");
  }
  return {
    slabs: p.slabs,
    creditUsdc: p.creditUsdc.toString(),
    ...(p.sellers?.length ? { sellers: p.sellers } : {}),
    ...(p.maxPerBuyer !== undefined ? { maxPerBuyer: p.maxPerBuyer.toString() } : {}),
    ...(p.baseUsdc !== undefined && p.baseTusdt !== undefined ? { base: { usdc: p.baseUsdc.toString(), tUsdt: p.baseTusdt.toString() } } : {}),
    idempotencyKey: p.idempotencyKey ?? shipKey(p),
  };
}

export interface LenderOptions {
  client: ToolCaller;
  /** Signs and sends calldata from the lender's wallet (see `walletCallSender`). */
  send: CallSender;
}

export function createLenderAgent({ client, send }: LenderOptions) {
  return {
    async ship(params: ShipParams): Promise<ShipOutcome> {
      const result = await client.call<Shipped | CalldataResult>("fund_agents", fundArguments(params));
      if (result.mode === "shipped") return result;
      const { slabs, strategies } = result;
      return { mode: "sent", slabs, strategies, txHashes: await sendInOrder(send, result.calls) };
    },
  };
}

export type LenderAgent = ReturnType<typeof createLenderAgent>;
