export interface UsdcSource {
  /** Human label for logs, e.g. "merchant". */
  name: string;
  id: string;
  key: string;
  /** Current USDC balance in base units. */
  balance: bigint;
}

/**
 * Chooses who pays a USDC top-up: the configured source if it holds enough, otherwise the
 * fallback (operator). Throws naming the shortfall when neither can cover `needed`.
 */
export function pickUsdcSource(
  needed: bigint,
  preferred: UsdcSource,
  fallback: UsdcSource,
): UsdcSource {
  if (preferred.balance >= needed) return preferred;
  if (fallback.balance >= needed) return fallback;
  throw new Error(
    `Insufficient USDC: need ${needed} units; ${preferred.name} (${preferred.id}) holds ` +
      `${preferred.balance}, ${fallback.name} (${fallback.id}) holds ${fallback.balance} ` +
      `(short by ${needed - (preferred.balance > fallback.balance ? preferred.balance : fallback.balance)}). ` +
      `Top up the operator from https://faucet.circle.com (Hedera Testnet).`,
  );
}
