import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";

/**
 * The two digests of an invoice file. `keccak256` is what goes on-chain as `detailsCommitment`; `sha256` (plain hex,
 * the output of `shasum -a 256`) lets anyone check the same file with standard tools.
 */
export function hashDocument(bytes: Uint8Array): { keccak256: Hex; sha256: string } {
  return { keccak256: keccak256(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
}
