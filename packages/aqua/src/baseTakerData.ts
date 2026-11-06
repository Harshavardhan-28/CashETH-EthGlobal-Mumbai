import { concatHex, numberToHex, type Hex } from "viem";

/** `TakerTraitsLib` flag bits (swap-vm `libs/TakerTraits.sol`). */
const IS_EXACT_IN = 0x0001;
const USE_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040;
const IS_A_TO_B = 0x0080;

const DATA_SLICES = 10;
const WORD_BYTES = 32;

/**
 * Taker bytes for an exact-in swap against a base-yield (`XYCSwap`) strategy by a taker contract that holds the
 * input token: `transferFrom` plus Aqua push, maker-to-taker transfer first, output to the caller, no hooks or
 * callbacks. `threshold` is the minimum output (absent or zero: none).
 *
 * `CashEthOrderBuilder.takerData` only builds the credit facility's taker bytes, so this mirrors
 * `TakerTraitsLib.build` for the plain case: ten big-endian uint16 slice end offsets, the uint16 flags, then the
 * threshold slice. With no `to`, deadline, hook or callback data, every slice ends where the threshold slice ends.
 */
export function baseTakerData(p: { isAToB: boolean; threshold?: bigint }): Hex {
  const threshold = p.threshold ?? 0n;
  if (threshold < 0n || threshold >= 1n << 256n) throw new Error(`threshold must fit in uint256, got ${threshold}`);
  const hasThreshold = threshold !== 0n;
  const sliceEnds = Array.from({ length: DATA_SLICES }, () => numberToHex(hasThreshold ? WORD_BYTES : 0, { size: 2 }));
  const flags = IS_EXACT_IN | USE_TRANSFER_FROM_AND_AQUA_PUSH | (p.isAToB ? IS_A_TO_B : 0);
  return concatHex([...sliceEnds, numberToHex(flags, { size: 2 }), hasThreshold ? numberToHex(threshold, { size: WORD_BYTES }) : "0x"]);
}
