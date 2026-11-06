/**
 * Spend-wallet policy for `reserve_spend`: the facility pays the reserved USDC to whatever `spendWallet` it is
 * given, so the server only accepts a wallet registered in `deployments/testnet/spend-wallets.json` whose live
 * key (mirror node) is a 2-of-2 threshold key over the worker and the configured policy co-signer. Only then does
 * every payment out of it need the co-signer, which signs nothing but the reserved merchant payment.
 */
import type { DecodedKey } from "@casheth/hedera";
import type { Address } from "viem";

export type SpendWalletProblem =
  | "not_registered"
  | "not_2_of_2"
  | "cosigner_not_a_signer"
  | "worker_key_unknown"
  | "worker_not_a_signer";

export interface SpendWalletPort {
  /** The co-signer's compressed secp256k1 public key (hex). */
  readonly cosignerPublicKey: string;
  /** The wallet's current key when it is a registered spend wallet, else `undefined`. Cached per wallet. */
  registeredKey(spendWallet: Address): Promise<DecodedKey | undefined>;
  /** The agent account's compressed secp256k1 public key (hex) from the mirror node, if it has one. Cached. */
  publicKeyOf(account: Address): Promise<string | undefined>;
}

/** Why `key` is not a 2-of-2 over exactly {worker, co-signer}, or `undefined` when it is. */
export function spendWalletKeyProblem(key: DecodedKey, cosignerPublicKey: string, workerPublicKey: string): SpendWalletProblem | undefined {
  if (key.threshold !== 2 || key.keys.length !== 2) return "not_2_of_2";
  const signers = key.keys.map((k) => k.publicKey.toLowerCase());
  if (!signers.includes(cosignerPublicKey.toLowerCase())) return "cosigner_not_a_signer";
  if (!signers.includes(workerPublicKey.toLowerCase())) return "worker_not_a_signer";
  return undefined;
}

/** Checks that `spendWallet` is a registered 2-of-2 wallet of `worker` and the co-signer. */
export async function spendWalletProblem(port: SpendWalletPort, spendWallet: Address, worker: Address): Promise<SpendWalletProblem | undefined> {
  const [key, workerPublicKey] = await Promise.all([port.registeredKey(spendWallet), port.publicKeyOf(worker)]);
  if (!key) return "not_registered";
  if (!workerPublicKey) return "worker_key_unknown";
  return spendWalletKeyProblem(key, port.cosignerPublicKey, workerPublicKey);
}
