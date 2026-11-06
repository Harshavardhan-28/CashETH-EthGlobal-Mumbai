/** Seller agent: puts an invoice on the books as an uploaded receivable awaiting the buyer's confirmation. */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";

export interface Invoice {
  buyer: Address;
  /** USDC base units (6 decimals). */
  amount: bigint;
  /** Unix seconds. */
  dueDate: bigint;
  /** The buyer's purchase-order reference (hashed by the server) or a 32-byte hash. */
  buyerRef: string;
  /** The seller's own 32-byte commitment; only used (and then required) when there is no `invoiceFile`. */
  detailsCommitment?: Hex;
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

/** `upload_invoice_document` result: the hashes anchored on HCS and what the server read from the file. */
export interface StoredDocument {
  keccak256: Hex;
  sha256: string;
  bytes: number;
  mime: string;
  extractor: "heuristic" | "ollama";
  extracted: Record<string, string>;
  verification: { ok: boolean; mismatches: { field: string; expected: string; found: string }[] } | null;
  hashscan?: string;
  downloadPath: string;
}

export interface UploadResult {
  pendingId: Hex;
  id: Hex;
  confirmationRequest: { typedData: WireTypedData };
  /** Set when an `invoiceFile` was uploaded first. */
  document?: StoredDocument;
}

const MIME_BY_EXTENSION: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain" };

export function createSellerAgent(client: ToolCaller) {
  /** Reads the file and stores it with `upload_invoice_document`, asking the server to check it against the invoice terms. */
  async function storeDocument(path: string, invoice: Invoice): Promise<StoredDocument> {
    const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (!mime) throw new Error(`invoiceFile ${path} must be a .pdf or .txt file`);
    const bytes = await readFile(path);
    return client.call<StoredDocument>("upload_invoice_document", {
      receivableRef: invoice.buyerRef,
      filename: path.split(/[\\/]/).pop(),
      mime,
      content: bytes.toString("base64"),
      expected: { amount: invoice.amount.toString(), dueDate: Number(invoice.dueDate), buyerRef: invoice.buyerRef },
      idempotencyKey: idempotencyKey("invoice-doc", invoice.buyer, invoice.buyerRef, invoice.amount.toString(), invoice.dueDate.toString(), keccak256(bytes)),
    });
  }

  return {
    /**
     * With an `invoiceFile` the document is stored first and its keccak256 becomes the receivable's commitment (the
     * server refuses terms that differ from what the file prints). The result goes to the buyer, who signs its
     * `confirmationRequest`. A repeat replays the first upload.
     */
    async run({ invoice, invoiceFile }: { invoice: Invoice; invoiceFile?: string }): Promise<UploadResult> {
      if (!invoiceFile && !invoice.detailsCommitment) throw new Error("run needs an invoiceFile or invoice.detailsCommitment");
      const document = invoiceFile ? await storeDocument(invoiceFile, invoice) : undefined;
      const upload = await client.call<UploadResult>("upload_receivable", {
        buyer: invoice.buyer,
        amount: invoice.amount.toString(),
        dueDate: Number(invoice.dueDate),
        buyerRef: invoice.buyerRef,
        ...(document ? { documentKeccak: document.keccak256 } : { detailsCommitment: invoice.detailsCommitment }),
        idempotencyKey: idempotencyKey("upload", invoice.buyer, invoice.buyerRef),
      });
      return document ? { ...upload, document } : upload;
    },
  };
}
