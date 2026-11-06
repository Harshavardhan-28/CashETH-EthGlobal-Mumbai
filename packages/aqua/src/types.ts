import type { Address, Hex } from "viem";

/**
 * `ReceivableCredit.Args`: the lender's risk rules, enforced by the credit opcode on every fill.
 * A non-empty `sellerSet` (at most 3) replaces the seller score thresholds.
 */
export type CreditArgs = {
  maxTenorDays: number;
  maxAdvanceBps: number;
  minBuyerOnTime: number;
  /** Lifetime USDC cap against one buyer across all of the lender's strategies (6 decimals). */
  maxPerBuyer: bigint;
  aprBps: number;
  minSellerOnTime: number;
  maxSellerDefaults: number;
  /** USDC the lender's wallet must keep after a fill (6 decimals). */
  minReserve: bigint;
  sellerSet: Address[];
};

export type Tier = "low" | "medium" | "high";

export type TierPreset = Omit<CreditArgs, "sellerSet" | "maxPerBuyer" | "minReserve">;

/** Risk-tier presets of the credit opcode arguments (plan Addendum A, D-A2). */
export const LENDER_TIERS: Readonly<Record<Tier, Readonly<TierPreset>>> = Object.freeze({
  low: Object.freeze({
    aprBps: 700,
    minSellerOnTime: 3,
    maxSellerDefaults: 0,
    minBuyerOnTime: 0,
    maxTenorDays: 60,
    maxAdvanceBps: 8000,
  }),
  medium: Object.freeze({
    aprBps: 850,
    minSellerOnTime: 1,
    maxSellerDefaults: 0,
    minBuyerOnTime: 0,
    maxTenorDays: 60,
    maxAdvanceBps: 8000,
  }),
  high: Object.freeze({
    aprBps: 1300,
    minSellerOnTime: 0,
    maxSellerDefaults: 2,
    minBuyerOnTime: 0,
    maxTenorDays: 60,
    maxAdvanceBps: 8000,
  }),
});

export type TierOptions = { sellerSet?: Address[]; maxPerBuyer?: bigint; minReserve?: bigint };

/** Full credit args for a tier: the preset plus the lender's seller set, per-buyer cap and reserve. */
export function tierArgs(tier: Tier, { sellerSet = [], maxPerBuyer = 5_000_000n, minReserve = 0n }: TierOptions = {}): CreditArgs {
  const preset = LENDER_TIERS[tier];
  if (!preset) throw new Error(`unknown tier ${String(tier)}`);
  if (sellerSet.length > 3) throw new Error(`sellerSet holds at most 3 sellers, got ${sellerSet.length}`);
  return { ...preset, maxPerBuyer, minReserve, sellerSet: [...sellerSet] };
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
