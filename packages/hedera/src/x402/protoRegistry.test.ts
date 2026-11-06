/**
 * Regression: `@hashgraphonline/standards-sdk` (HCS-14 UAIDs, loaded by `@casheth/hedera`) brings `@hashgraph/proto`.
 * Every Hedera protobuf build registers its types in the shared `protobufjs.roots.hashgraph`; when an older build
 * shares the protobufjs instance with `@hiero-ledger/proto` (what `@x402/hedera` and `@hiero-ledger/sdk` use), it
 * replaces the newer types there and `pay_x402` failed with "Cannot read properties of undefined (reading 'encode')".
 */
import type { PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { PrivateKey, Transaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { beforeAll, describe, expect, it } from "vitest";
import { addSignature, createCosignedHederaSigner } from "./cosignedSigner.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "250000",
  asset: "0.0.429274",
  payTo: "0.0.6006",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.7007" },
};

describe("x402 payload with the standards SDK loaded", () => {
  beforeAll(async () => {
    // Loaded after @x402/hedera, as in the MCP server process.
    await import("@hashgraphonline/standards-sdk");
  });

  it("builds, decodes and co-signs the payment transaction", async () => {
    const worker = PrivateKey.generateECDSA();
    const cosigner = PrivateKey.generateECDSA();
    const signer = createCosignedHederaSigner({
      accountId: "0.0.5005",
      workerKey: worker,
      network: "hedera:testnet",
      // The MCP co-signer decodes the transfer before signing it.
      cosign: async (tx) => {
        Transaction.fromBytes(Buffer.from(tx, "base64"));
        return addSignature(tx, cosigner);
      },
    });
    const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));

    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "http://localhost:3003/research", description: "", mimeType: "" },
      accepts: [requirements],
    });

    const tx = Transaction.fromBytes(Buffer.from(String(payload.payload.transaction), "base64"));
    expect(worker.publicKey.verifyTransaction(tx)).toBe(true);
    expect(cosigner.publicKey.verifyTransaction(tx)).toBe(true);
  });
});
