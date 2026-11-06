import {
  AccountId,
  PrivateKey,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@x402/hedera";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { addSignature, createCosignedHederaSigner } from "./cosignedSigner.js";

const USDC = "0.0.429274";
const NODE = AccountId.fromString("0.0.3");

/** A frozen USDC transfer with a single node, built without touching the network. */
function frozenTransferBase64(): string {
  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(USDC), "0.0.5005", -250_000)
    .addTokenTransfer(TokenId.fromString(USDC), "0.0.6006", 250_000)
    .setNodeAccountIds([NODE])
    .setTransactionId(TransactionId.generate("0.0.7007"))
    .freeze();
  return Buffer.from(tx.toBytes()).toString("base64");
}

/** Public keys (raw hex) that signed the body sent to node 0.0.3. */
function signersForNode(b64: string, node: AccountId): string[] {
  const tx = Transaction.fromBytes(Buffer.from(b64, "base64"));
  const forNode = tx.getSignatures().get(node);
  if (!forNode) return [];
  const keys: string[] = [];
  for (const [, pairs] of forNode) for (const [publicKey] of pairs) keys.push(publicKey.toStringRaw());
  return keys;
}

describe("addSignature", () => {
  it("cosigned signer output carries two signatures for a 2-of-2 key list", async () => {
    const worker = PrivateKey.generateECDSA();
    const cosigner = PrivateKey.generateECDSA();

    const once = await addSignature(frozenTransferBase64(), worker);
    const twice = await addSignature(once, cosigner);

    const signers = signersForNode(twice, NODE);
    expect(signers).toHaveLength(2);
    expect(new Set(signers)).toEqual(
      new Set([worker.publicKey.toStringRaw(), cosigner.publicKey.toStringRaw()]),
    );
    const decoded = Transaction.fromBytes(Buffer.from(twice, "base64"));
    expect(worker.publicKey.verifyTransaction(decoded)).toBe(true);
    expect(cosigner.publicKey.verifyTransaction(decoded)).toBe(true);
  });
});

describe("createCosignedHederaSigner", () => {
  it("passes the worker-signed transfer through cosign and returns its result", async () => {
    const worker = PrivateKey.generateECDSA();
    const cosigner = PrivateKey.generateECDSA();
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      amount: "250000",
      asset: USDC,
      payTo: "0.0.6006",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.7007" },
    };
    const seen: { tx?: string; requirements?: PaymentRequirements } = {};

    const signer = createCosignedHederaSigner({
      accountId: "0.0.5005",
      workerKey: worker,
      network: "hedera:testnet",
      cosign: async (txBase64, reqs) => {
        seen.tx = txBase64;
        seen.requirements = reqs;
        return addSignature(txBase64, cosigner);
      },
    });
    const out = await signer.createPartiallySignedTransferTransaction(requirements);

    expect(signer.accountId).toBe("0.0.5005");
    expect(seen.requirements).toBe(requirements);
    const workerOnly = Transaction.fromBytes(Buffer.from(seen.tx!, "base64"));
    expect(worker.publicKey.verifyTransaction(workerOnly)).toBe(true);
    expect(cosigner.publicKey.verifyTransaction(workerOnly)).toBe(false);

    const both = Transaction.fromBytes(Buffer.from(out, "base64"));
    expect(both.transactionId?.accountId?.toString()).toBe("0.0.7007");
    expect(worker.publicKey.verifyTransaction(both)).toBe(true);
    expect(cosigner.publicKey.verifyTransaction(both)).toBe(true);
    for (const node of both.nodeAccountIds ?? []) {
      expect(signersForNode(out, node)).toHaveLength(2);
    }
  });
});
