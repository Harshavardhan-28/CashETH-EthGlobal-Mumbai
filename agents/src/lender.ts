/**
 * Lender agent: ships a credit strategy (and optionally a base-yield one) through `fund_agents`. When the MCP server
 * holds the lender key it ships itself; otherwise it returns the exact-amount approvals and ship calls, and the
 * lender signs and sends them from its own wallet.
 */
import type { Tier } from "@casheth/aqua";
import type { Address, Hex } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";
import { sendInOrder, type CallSender, type Calldata } from "./sendCalls.js";

export interface ShipParams {
  tier: Tier;
  /** At most 3 sellers; replaces the tier's seller thresholds. */
  sellerSet?: Address[];
  /** USDC base units (6 decimals) committed to the credit strategy. */
  creditUsdc: bigint;
  /** Base-yield strategy amounts; give both or neither. */
  baseUsdc?: bigint;
  baseTusdt?: bigint;
  /**
   * The default idempotency key is derived from the strategy (tier, amounts, seller set) and this attempt id
   * (default "1"), so retrying a ship replays the first result; use a new attempt to ship an identical strategy again.
   */
  attempt?: string;
  /** Overrides the derived key. */
  idempotencyKey?: string;
}

/** Same strategy parameters and attempt, same key. */
function shipKey(p: ShipParams): string {
  const sellers = (p.sellerSet ?? []).map((s) => s.toLowerCase()).sort().join(",");
  return idempotencyKey("fund", p.tier, p.creditUsdc.toString(), sellers, String(p.baseUsdc ?? ""), String(p.baseTusdt ?? ""), p.attempt ?? "1");
}

type Strategies = { credit: Hex; base?: Hex };
type Shipped = { mode: "shipped"; tier: Tier; aprBps: number; credit: Record<string, unknown>; base?: Record<string, unknown> };
type CalldataResult = { mode: "calldata"; tier: Tier; aprBps: number; calls: Calldata[]; strategies: Strategies };
export type ShipOutcome = Shipped | { mode: "sent"; tier: Tier; aprBps: number; strategies: Strategies; txHashes: Hex[] };

function fundArguments(p: ShipParams): Record<string, unknown> {
  if ((p.baseUsdc === undefined) !== (p.baseTusdt === undefined)) {
    throw new Error("a base-yield strategy needs both baseUsdc and baseTusdt");
  }
  return {
    tier: p.tier,
    creditUsdc: p.creditUsdc.toString(),
    ...(p.sellerSet?.length ? { sellerSet: p.sellerSet } : {}),
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
      const { tier, aprBps, strategies } = result;
      return { mode: "sent", tier, aprBps, strategies, txHashes: await sendInOrder(send, result.calls) };
    },
  };
}

export type LenderAgent = ReturnType<typeof createLenderAgent>;
