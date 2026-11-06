/**
 * x402 Hedera signer for a threshold-key (KeyList) payer: the worker key signs the facilitator-paid
 * TransferTransaction built by `@x402/hedera`, then a policy co-signer adds its signature.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { createClientHederaSigner, Transaction, type ClientHederaSigner, type PrivateKey } from "@x402/hedera";

/** Adds `key`'s signature to a frozen, base64-encoded transaction; existing signatures are kept. */
export async function addSignature(txBase64: string, key: PrivateKey): Promise<string> {
  const tx = Transaction.fromBytes(Buffer.from(txBase64, "base64"));
  await tx.sign(key);
  return Buffer.from(tx.toBytes()).toString("base64");
}

export interface CosignedSignerOptions {
  /** Payer account id; its on-chain key is the KeyList the two signatures must satisfy. */
  accountId: string;
  workerKey: PrivateKey;
  /** CAIP-2 network, e.g. `hedera:testnet`. */
  network: string;
  /**
   * Policy co-signer: receives the worker-signed transaction and the requirements it pays, returns
   * the transaction with its signature added (or throws to refuse).
   */
  cosign: (txBase64: string, requirements: PaymentRequirements) => Promise<string>;
}

export function createCosignedHederaSigner({
  accountId,
  workerKey,
  network,
  cosign,
}: CosignedSignerOptions): ClientHederaSigner {
  const inner = createClientHederaSigner(accountId, workerKey, { network });
  return {
    accountId: inner.accountId,
    async createPartiallySignedTransferTransaction(requirements) {
      const workerSigned = await inner.createPartiallySignedTransferTransaction(requirements);
      return cosign(workerSigned, requirements);
    },
  };
}
