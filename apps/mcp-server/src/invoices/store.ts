/** Uploaded invoice documents on disk: `<dir>/<keccak256>.<ext>` holds the bytes, `<dir>/<keccak256>.json` the metadata. */
import type { InvoiceFields } from "@casheth/engine";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";

/** MIME types accepted for invoice documents, with the file extension each is stored under. */
export const DOCUMENT_TYPES = { "application/pdf": "pdf", "text/plain": "txt" } as const;

export type DocumentMime = keyof typeof DOCUMENT_TYPES;

export function isDocumentMime(mime: string): mime is DocumentMime {
  return mime in DOCUMENT_TYPES;
}

export type InvoiceDocumentMeta = {
  keccak256: Hex;
  sha256: string;
  bytes: number;
  mime: DocumentMime;
  filename: string;
  /** The reference the seller gave the upload (PO number or receivable id). */
  receivableRef: string;
  /** The agent that uploaded it; only that agent can attach it to a receivable. */
  uploader: Address;
  uploadedAt: string;
  extractor: "heuristic" | "ollama";
  model?: string;
  extracted: InvoiceFields;
  hcsSeq?: number;
  hcsTxId?: string;
  hfsFileId?: string;
};

export class InvoiceStore {
  constructor(private readonly dir: string) {}

  #path(keccak: string, ext: string): string {
    return join(this.dir, `${keccak.toLowerCase()}.${ext}`);
  }

  /** The metadata of the document with this keccak256, if stored. `keccak` must be a validated 32-byte hex. */
  meta(keccak: string): InvoiceDocumentMeta | undefined {
    const path = this.#path(keccak, "json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as InvoiceDocumentMeta) : undefined;
  }

  /** Where the document's bytes live on disk. */
  filePath(meta: InvoiceDocumentMeta): string {
    return this.#path(meta.keccak256, DOCUMENT_TYPES[meta.mime]);
  }

  /** The stored bytes of a document (read from disk, so tampering with the file is visible to callers that re-hash). */
  bytes(meta: InvoiceDocumentMeta): Uint8Array {
    return readFileSync(this.filePath(meta));
  }

  /** Writes the bytes first and the metadata last, so a metadata file always has its document. */
  put(meta: InvoiceDocumentMeta, bytes: Uint8Array): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath(meta), bytes);
    this.update(meta);
  }

  update(meta: InvoiceDocumentMeta): void {
    writeFileSync(this.#path(meta.keccak256, "json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
}
