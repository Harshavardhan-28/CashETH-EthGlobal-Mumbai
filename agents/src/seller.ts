/** Seller agent: puts an invoice on the books as an uploaded receivable awaiting the buyer's confirmation. */
import type { Address, Hex } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";

export interface Invoice {
  buyer: Address;
  /** USDC base units (6 decimals). */
  amount: bigint;
  /** Unix seconds. */
  dueDate: bigint;
  /** The buyer's purchase-order reference (hashed by the server) or a 32-byte hash. */
  buyerRef: string;
  detailsCommitment: Hex;
}

/** EIP-712 `ReceivableConfirmation` as `upload_receivable` returns it: every uint is a decimal string. */
export interface WireTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  message: {
    seller: Address;
    buyer: Address;
    currency: Address;
    amount: string;
    dueDate: string;
    buyerRef: Hex;
    detailsCommitment: Hex;
    payTo: Address;
    nonce: string;
    deadline: string;
  };
}

export interface UploadResult {
  pendingId: Hex;
  id: Hex;
  confirmationRequest: { typedData: WireTypedData };
}

export function createSellerAgent(client: ToolCaller) {
  return {
    /** `upload_receivable`; the result goes to the buyer, who signs its `confirmationRequest`. A repeat replays the first upload. */
    run({ invoice }: { invoice: Invoice }): Promise<UploadResult> {
      return client.call<UploadResult>("upload_receivable", {
        buyer: invoice.buyer,
        amount: invoice.amount.toString(),
        dueDate: Number(invoice.dueDate),
        buyerRef: invoice.buyerRef,
        detailsCommitment: invoice.detailsCommitment,
        idempotencyKey: idempotencyKey("upload", invoice.buyer, invoice.buyerRef),
      });
    },
  };
}
