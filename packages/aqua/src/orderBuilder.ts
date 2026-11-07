/**
 * Thin wrappers over `CashEthOrderBuilder` (eth_call only). Every SwapVM byte comes from the contract,
 * which uses the pinned SwapVM libraries; nothing here encodes programs or traits by hand.
 */
import { CashEthOrderBuilderAbi } from "@casheth/shared";
import type { Address, Hex, PublicClient } from "viem";
import type { CreditArgs, Order } from "./types.js";

/** FeeFlatIn denominates fees in 1e7 (30_000 = 0.3%); this package takes basis points (30 = 0.3%). */
export const FEE_FLAT_IN_UNITS_PER_BPS = 1_000;

/** The input fee, in basis points, of the demo lenders' base-yield strategies (0.3%). */
export const BASE_FEE_BPS = 30;

type Reader =Pick<PublicClient, "readContract">;

function toOrder(o: { maker: Address; traits: bigint; data: Hex }): Order {
  return { maker: o.maker, traits: o.traits, data: o.data };
}

function toArgs(a: {
  maxTenorDays: number;
  maxAdvanceBps: number;
  maxPerBuyer: bigint;
  slabMask: number;
  minReserve: bigint;
  sellerSet: readonly Address[];
}): CreditArgs {
  return {
    maxTenorDays: a.maxTenorDays,
    maxAdvanceBps: a.maxAdvanceBps,
    maxPerBuyer: a.maxPerBuyer,
    slabMask: a.slabMask,
    minReserve: a.minReserve,
    sellerSet: [...a.sellerSet],
  };
}

/** Credit-line order `Salt(salt) ‖ ReceivableCredit(args)` over (USDC, RCN) and its Aqua strategy bytes. */
export async function buildLenderOrder(
  client: Reader,
  builder: Address,
  p: { maker: Address; rcn: Address; usdc: Address; args: CreditArgs; salt: bigint },
): Promise<{ order: Order; strategy: Hex }> {
  const [order, strategy] = await client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "buildLenderOrder",
    args: [p.maker, p.rcn, p.usdc, p.args, p.salt],
  });
  return { order: toOrder(order), strategy };
}

/**
 * Base-yield order `Salt(salt) ‖ FeeFlatIn ‖ XYCSwap` over (USDC, tUSDT) and its strategy bytes.
 * @param p.feeBps Input fee in basis points (30 = 0.3%).
 */
export async function buildBaseYieldOrder(
  client: Reader,
  builder: Address,
  p: { maker: Address; usdc: Address; tUsdt: Address; feeBps: number; salt: bigint },
): Promise<{ order: Order; strategy: Hex }> {
  if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps >= 10_000) {
    throw new Error(`feeBps must be an integer in [0, 10000), got ${p.feeBps}`);
  }
  const [order, strategy] = await client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "buildBaseYieldOrder",
    args: [p.maker, p.usdc, p.tUsdt, p.feeBps * FEE_FLAT_IN_UNITS_PER_BPS, p.salt],
  });
  return { order: toOrder(order), strategy };
}

/** Inverse of `buildLenderOrder`; rejects (`NotLenderOrder`) any other program. Tokens come back sorted. */
export async function decodeLenderOrder(
  client: Reader,
  builder: Address,
  order: Order,
): Promise<{ args: CreditArgs; salt: bigint; tokenA: Address; tokenB: Address }> {
  const [args, salt, tokenA, tokenB] = await client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "decodeLenderOrder",
    args: [order],
  });
  return { args: toArgs(args), salt, tokenA, tokenB };
}

/** Inverse of `buildBaseYieldOrder`; rejects (`NotBaseYieldOrder`) any other program. `feeBps` in basis points. */
export async function decodeBaseYieldOrder(
  client: Reader,
  builder: Address,
  order: Order,
): Promise<{ feeBps: number; salt: bigint; tokenA: Address; tokenB: Address }> {
  const [fee, salt, tokenA, tokenB] = await client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "decodeBaseYieldOrder",
    args: [order],
  });
  return { feeBps: fee / FEE_FLAT_IN_UNITS_PER_BPS, salt, tokenA, tokenB };
}

/** The taker data the credit facility sends for a fill of `amount` against receivable `id`. */
export async function takerData(
  client: Reader,
  builder: Address,
  p: { facility: Address; rcn: Address; usdc: Address; amount: bigint; id: Hex; advanceBps: number },
): Promise<Hex> {
  return client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "takerData",
    args: [p.facility, p.rcn, p.usdc, p.amount, p.id, p.advanceBps],
  });
}

/** Aqua strategy hash of `order` (`keccak256(abi.encode(order))`, equal to the router's `hash(order)`). */
export async function strategyHash(client: Reader, builder: Address, order: Order): Promise<Hex> {
  return client.readContract({
    address: builder,
    abi: CashEthOrderBuilderAbi,
    functionName: "strategyHash",
    args: [order],
  });
}
