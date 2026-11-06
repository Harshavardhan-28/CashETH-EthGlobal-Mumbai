/**
 * Seller agent: puts an invoice on the books as an uploaded receivable awaiting the buyer's confirmation, then
 * draws credit against it once confirmed (quotes, facility, worker budgets).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { idempotencyKey, type ToolCaller } from "./mcpClient.js";
import { sendInOrder, type CallSender, type Calldata } from "./sendCalls.js";

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

/** A lender strategy the solver considered for a receivable (docs/API.md `get_quotes`). */
export interface QuotedStrategy {
  maker: Address;
  strategyHash: Hex;
  kind: "credit" | "base";
  aprBps?: number;
  virtualUsdc: string;
  realUsdc: string;
}

export interface PlannedFill {
  maker: Address;
  strategyHash: Hex;
  amount: string;
  aprBps: number;
}

export interface SkippedStrategy {
  strategyHash: Hex;
  reason: string;
}

export interface Quotes {
  id: Hex;
  decision: { approved: boolean; score: number; advanceBps: number; limit: string; reasons: string[] };
  borrowingBase: string;
  strategies: QuotedStrategy[];
  plan: { fills: PlannedFill[]; total: string; skipped: SkippedStrategy[] };
}

export interface FacilityOpened {
  id: Hex;
  txHash: Hex;
  hashscan: string;
  funded: string;
  borrowingBase: string;
  partial: boolean;
  fills: PlannedFill[];
  total: string;
  skipped: SkippedStrategy[];
}

/** One worker's slice of the facility; amounts are USDC base units. */
export interface WorkerBudget {
  worker: Address;
  alloc: bigint;
  maxPerTx: bigint;
  maxDaily: bigint;
  merchants: Address[];
}

type BudgetsResult = { mode: "sent"; txHash: Hex } | { mode: "calldata"; calls: Calldata[] };

const MIME_BY_EXTENSION: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain" };

/** `get_receivable_status`; `document.verified` is true once the registry commitment equals the stored file's hash. */
export interface ReceivableStatus {
  id: Hex;
  state: string;
  document?: { keccak: Hex; verified: boolean };
}

/** `send` signs and sends the `set_budgets` calldata when the server does not hold the seller key. */
export function createSellerAgent(client: ToolCaller, send?: CallSender) {
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
     * `confirmationRequest`. A repeat replays the first upload; a different `submission` is a separate attempt for
     * the same invoice (the server then answers `DUPLICATE_RECEIVABLE` once the first one is registered).
     */
    async run({ invoice, invoiceFile, submission }: { invoice: Invoice; invoiceFile?: string; submission?: string }): Promise<UploadResult> {
      if (!invoiceFile && !invoice.detailsCommitment) throw new Error("run needs an invoiceFile or invoice.detailsCommitment");
      const document = invoiceFile ? await storeDocument(invoiceFile, invoice) : undefined;
      const upload = await client.call<UploadResult>("upload_receivable", {
        buyer: invoice.buyer,
        amount: invoice.amount.toString(),
        dueDate: Number(invoice.dueDate),
        buyerRef: invoice.buyerRef,
        ...(document ? { documentKeccak: document.keccak256 } : { detailsCommitment: invoice.detailsCommitment }),
        idempotencyKey: idempotencyKey("upload", invoice.buyer, invoice.buyerRef, ...(submission ? [submission] : [])),
      });
      return document ? { ...upload, document } : upload;
    },

    /** `get_receivable_status`: on-chain state and the invoice document's verification. */
    status(id: Hex): Promise<ReceivableStatus> {
      return client.call<ReceivableStatus>("get_receivable_status", { id });
    },

    /** `get_quotes`: the lender strategies and the cheapest-first plan for a confirmed receivable; sends nothing. */
    quotes(id: Hex): Promise<Quotes> {
      return client.call<Quotes>("get_quotes", { id });
    },

    /** `open_facility`: funds the receivable from the planned fills in one transaction. A repeat replays. */
    openFacility(id: Hex): Promise<FacilityOpened> {
      return client.call<FacilityOpened>("open_facility", { id, idempotencyKey: idempotencyKey("open-facility", id) });
    },

    /** `set_budgets`; resolves with the hash of the transaction that set them. */
    async setBudgets(id: Hex, budgets: WorkerBudget[]): Promise<{ txHash: Hex }> {
      const result = await client.call<BudgetsResult>("set_budgets", {
        id,
        budgets: budgets.map((b) => ({ ...b, alloc: b.alloc.toString(), maxPerTx: b.maxPerTx.toString(), maxDaily: b.maxDaily.toString() })),
        idempotencyKey: idempotencyKey("set-budgets", id),
      });
      if (result.mode === "sent") return { txHash: result.txHash };
      const hashes = await sendInOrder(send, result.calls);
      return { txHash: hashes[hashes.length - 1]! };
    },
  };
}

export type SellerAgent = ReturnType<typeof createSellerAgent>;
