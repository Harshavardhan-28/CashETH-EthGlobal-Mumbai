import type { Address, Hex } from "viem";

/** The risk slabs of `RiskPricing.sol`: a seller's score puts it in one, and its rate follows from the score. */
export type RiskSlab = "low" | "medium" | "high";

export const RISK_SLABS: readonly RiskSlab[] = ["low", "medium", "high"];

const SLAB_BIT: Readonly<Record<RiskSlab, number>> = { low: 1, medium: 2, high: 4 };

/**
 * `ReceivableCredit.Args`: the lender's rules, enforced by the credit opcode on every fill. The lender picks the
 * risk slabs it funds (`slabMask`) and optionally up to 3 sellers; the price is the seller's own, set on chain.
 */
export type CreditArgs = {
  maxTenorDays: number;
  maxAdvanceBps: number;
  /** Lifetime USDC cap against one buyer across all of the lender's strategies (6 decimals). */
  maxPerBuyer: bigint;
  /** Funded slabs: bit 0 low, bit 1 medium, bit 2 high (see `slabMask`). */
  slabMask: number;
  /** USDC the lender's wallet must keep after a fill (6 decimals). */
  minReserve: bigint;
  /** When non-empty, only these sellers (and only in a funded slab). */
  sellerSet: Address[];
};

export function slabMask(slabs: readonly RiskSlab[]): number {
  if (slabs.length === 0) throw new Error("a credit strategy funds at least one slab");
  return slabs.reduce((mask, slab) => mask | SLAB_BIT[slab], 0);
}

/** The slabs a mask funds, safest first. */
export function slabsOf(mask: number): RiskSlab[] {
  return RISK_SLABS.filter((slab) => (mask & SLAB_BIT[slab]) !== 0);
}

export type CreditOptions = {
  sellerSet?: Address[];
  maxPerBuyer?: bigint;
  minReserve?: bigint;
  maxTenorDays?: number;
  maxAdvanceBps?: number;
};

/** Credit args for the slabs a lender funds, with its optional seller list, per-buyer cap and reserve. */
export function creditArgs(
  slabs: readonly RiskSlab[],
  { sellerSet = [], maxPerBuyer = 5_000_000n, minReserve = 0n, maxTenorDays = 60, maxAdvanceBps = 8000 }: CreditOptions = {},
): CreditArgs {
  if (sellerSet.length > 3) throw new Error(`sellerSet holds at most 3 sellers, got ${sellerSet.length}`);
  return { maxTenorDays, maxAdvanceBps, maxPerBuyer, slabMask: slabMask(slabs), minReserve, sellerSet: [...sellerSet] };
}

/** `ISwapVM.Order`; `traits` is the packed `MakerTraits` word. */
export type Order = { maker: Address; traits: bigint; data: Hex };

/** One open Aqua strategy of a lender on the CashETH SwapVM router. */
export type LenderStrategy = {
  /** `credit`: `Salt ‖ ReceivableCredit` over (USDC, RCN); `base`: `Salt ‖ FeeFlatIn ‖ XYCSwap` over (USDC, tUSDT). */
  kind: "credit" | "base";
  maker: Address;
  strategyHash: Hex;
  order: Order;
  /** Credit strategies only. */
  args?: CreditArgs;
  /** Base strategies only, in basis points (30 = 0.3%). */
  feeBps?: number;
  salt: bigint;
  /** `[USDC, RCN]` for credit, `[USDC, tUSDT]` for base: USDC always first. */
  tokens: [Address, Address];
  /** Aqua virtual balance per token (`aqua.safeBalances`). */
  virtual: Record<Address, bigint>;
  /** USDC actually in the maker's wallet. */
  realUsdc: bigint;
  /** The maker's USDC allowance to Aqua. */
  allowance: bigint;
};

/** One `CreditFacility.openAndFund` fill. */
export type Fill = { order: Order; amount: bigint; aprBps: number };

/** Deployed contracts the package talks to. */
export type AquaAddresses = {
  aqua: Address;
  swapRouter: Address;
  orderBuilder: Address;
  usdc: Address;
  rcn: Address;
  /** Needed only for base-yield strategies. */
  tUsdt?: Address;
};
