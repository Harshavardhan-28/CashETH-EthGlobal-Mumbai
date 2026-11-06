/**
 * Invoice documents. The seller uploads the file; its keccak256 becomes the receivable's `detailsCommitment`, which
 * the buyer's EIP-712 signature covers, so anyone can download the file, hash it and compare with the registry.
 * The server stores the bytes, anchors their hashes on the HCS audit topic (optionally copies them to HFS) and reads
 * the printed fields so `upload_receivable` can check them against the terms the seller submits.
 */
import { verifyInvoiceFields, type InvoiceFields, type InvoiceVerification } from "@casheth/engine";
import { hashscan } from "@casheth/shared";
import { keccak256, type Address, type Hex } from "viem";
import { hashDocument } from "../invoices/hash.js";
import { DOCUMENT_TYPES, isDocumentMime, type InvoiceDocumentMeta } from "../invoices/store.js";
import { jsonSafe, record } from "./audit.js";
import { actor, bytes32, bytes32OrHash, sameAddress, STATE } from "./common.js";
import { fail } from "./errors.js";
import type { Caller, Orchestrator } from "./types.js";

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Longest base64 text that can decode to `MAX_DOCUMENT_BYTES`. */
export const MAX_DOCUMENT_BASE64_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;

/** Terms a document is checked against (the amount in USDC base units, the due date in unix seconds). */
export type ExpectedTerms = { amount: string; currency?: string; dueDate: number; buyerRef: string; sellerName?: string; buyerName?: string };

export type UploadDocumentInput = {
  receivableRef: string;
  filename: string;
  mime: string;
  content: string;
  expected?: ExpectedTerms;
};

function decode(content: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) fail("BAD_INPUT", "content must be base64", { field: "content" });
  const bytes = Buffer.from(content, "base64");
  if (bytes.length > MAX_DOCUMENT_BYTES) fail("BAD_INPUT", `the document is larger than ${MAX_DOCUMENT_BYTES} bytes`, { field: "content" });
  return bytes;
}

function toVerification(fields: InvoiceFields, expected: ExpectedTerms): InvoiceVerification {
  return verifyInvoiceFields(fields, { currency: "USDC", ...expected }, { hashRef: bytes32OrHash });
}

/** What the tools return about a stored document (the file itself is served by `GET /invoices/:keccak`). */
function view(meta: InvoiceDocumentMeta) {
  return {
    keccak256: meta.keccak256,
    sha256: meta.sha256,
    bytes: meta.bytes,
    mime: meta.mime,
    filename: meta.filename,
    receivableRef: meta.receivableRef,
    extractor: meta.extractor,
    ...(meta.model ? { model: meta.model } : {}),
    extracted: meta.extracted,
    ...(meta.hcsSeq !== undefined ? { hcsSeq: meta.hcsSeq } : {}),
    ...(meta.hcsTxId ? { hashscan: hashscan.tx(meta.hcsTxId) } : {}),
    ...(meta.hfsFileId ? { hfsFileId: meta.hfsFileId } : {}),
    downloadPath: `/invoices/${meta.keccak256}`,
  };
}

/** `upload_invoice_document`: stores the file, anchors its hashes on HCS and reads its printed fields. */
export async function uploadInvoiceDocument(o: Orchestrator, caller: Caller, input: UploadDocumentInput) {
  if (!isDocumentMime(input.mime)) fail("BAD_INPUT", `mime must be one of ${Object.keys(DOCUMENT_TYPES).join(", ")}`, { field: "mime" });
  const bytes = decode(input.content);
  if (bytes.length === 0) fail("BAD_INPUT", "the document is empty", { field: "content" });
  if (input.mime === "application/pdf" && Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    fail("BAD_INPUT", "the file is not a PDF", { field: "content" });
  }
  const hashes = hashDocument(bytes);

  const existing = o.invoices.meta(hashes.keccak256);
  if (existing) {
    if (!sameAddress(existing.uploader, caller.agent)) fail("NOT_PARTY", "this document was already uploaded by another agent");
    return withVerification(view(existing), existing.extracted, input.expected);
  }

  const extraction = await o.extractor.extract({ bytes, mime: input.mime });
  let meta: InvoiceDocumentMeta = {
    ...hashes,
    bytes: bytes.length,
    mime: input.mime,
    filename: input.filename,
    receivableRef: input.receivableRef,
    uploader: caller.agent,
    uploadedAt: new Date(Number(o.now()) * 1000).toISOString(),
    extractor: extraction.extractor,
    ...(extraction.model ? { model: extraction.model } : {}),
    extracted: extraction.fields,
  };
  o.invoices.put(meta, bytes);

  let hfsError: string | undefined;
  if (o.hfs) {
    try {
      meta = { ...meta, hfsFileId: (await o.hfs.store(bytes, `CashETH invoice ${hashes.keccak256}`)).fileId };
    } catch (err) {
      hfsError = err instanceof Error ? err.message : String(err);
      o.log("hfs store failed", { keccak256: hashes.keccak256, error: hfsError });
    }
  }

  const event = await record(o, {
    type: "InvoiceDocumentStored",
    receivableRef: input.receivableRef,
    sha256: hashes.sha256,
    keccak256: hashes.keccak256,
    bytes: bytes.length,
    mime: input.mime,
    ...(meta.hfsFileId ? { hfsFileId: meta.hfsFileId } : {}),
    ...actor(caller),
  });
  if (typeof event.hcsSeq === "number") meta = { ...meta, hcsSeq: event.hcsSeq };
  if (typeof event.hcsTxId === "string") meta = { ...meta, hcsTxId: event.hcsTxId };
  o.invoices.update(meta);

  return {
    ...withVerification(view(meta), meta.extracted, input.expected),
    ...(hfsError ? { hfsError } : {}),
    ...(typeof event.hcsError === "string" ? { hcsError: event.hcsError } : {}),
  };
}

function withVerification<T extends object>(base: T, fields: InvoiceFields, expected: ExpectedTerms | undefined) {
  return { ...base, verification: expected ? toVerification(fields, expected) : null };
}

/**
 * `get_invoice_document`: metadata, plus two integrity checks: the stored bytes still hash to their name, and, when
 * a receivable was uploaded with this document, whether the registry holds that hash as its `detailsCommitment`.
 */
export async function getInvoiceDocument(o: Orchestrator, _caller: Caller, input: { keccak: string }) {
  const keccak = bytes32(input.keccak, "keccak");
  const meta = o.invoices.meta(keccak);
  if (!meta) fail("NOT_FOUND", `no invoice document ${keccak}`);
  const storedHashMatches = keccak256(o.invoices.bytes(meta)) === keccak;

  const uploaded = o.events
    .list()
    .filter((e) => e.type === "ReceivableUploaded" && e.documentKeccak === keccak)
    .at(-1);
  let onChain: { receivableId: Hex; registered: boolean; commitment?: Hex; matches?: boolean } | undefined;
  if (uploaded?.id) {
    const receivableId = uploaded.id as Hex;
    const r = await o.chain.receivable(receivableId);
    onChain =
      r.state === STATE.None
        ? { receivableId, registered: false }
        : { receivableId, registered: true, commitment: r.detailsCommitment, matches: r.detailsCommitment.toLowerCase() === keccak };
  }
  return jsonSafe({ ...view(meta), verification: { storedHashMatches, ...(onChain ? { onChain } : {}) } });
}

/** `{ keccak, verified }` for a receivable whose registry commitment is a stored document, else undefined. */
export function documentOfCommitment(o: Orchestrator, commitment: Hex): { keccak: Hex; verified: boolean } | undefined {
  const meta = o.invoices.meta(commitment);
  if (!meta) return undefined;
  return { keccak: meta.keccak256, verified: keccak256(o.invoices.bytes(meta)) === commitment.toLowerCase() };
}

/**
 * The stored document `upload_receivable` names, checked against the submitted terms. The caller must be the
 * uploader and the bytes on disk must still hash to the name; the result says whether the printed fields match.
 */
export function checkDocumentAgainstTerms(o: Orchestrator, seller: Address, keccak: Hex, terms: ExpectedTerms): InvoiceVerification {
  const meta = o.invoices.meta(keccak);
  if (!meta) fail("NOT_FOUND", `no invoice document ${keccak}; call upload_invoice_document first`);
  if (!sameAddress(meta.uploader, seller)) fail("NOT_PARTY", "the document was uploaded by another agent");
  if (keccak256(o.invoices.bytes(meta)) !== keccak) fail("INVOICE_MISMATCH", "the stored document no longer matches its hash", { keccak });
  return toVerification(meta.extracted, terms);
}
