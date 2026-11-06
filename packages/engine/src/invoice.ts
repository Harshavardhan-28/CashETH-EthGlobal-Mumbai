/**
 * Invoice document verification: compares the fields read from an uploaded invoice with the terms the seller
 * submitted. Pure; reading the document (PDF text, an LLM) lives in the MCP server.
 */

/** Fields an extractor read from the document. Anything it could not find is absent. */
export type InvoiceFields = {
  /** USDC base units (6 decimals) as a decimal string. */
  amount?: string;
  /** Currency code as printed (`USDC`). */
  currency?: string;
  /** Due date as `YYYY-MM-DD` (UTC). */
  dueDate?: string;
  /** The buyer's purchase-order / AP reference as printed. */
  buyerRef?: string;
  sellerName?: string;
  buyerName?: string;
};

/** The terms the seller submitted with `upload_receivable` (and, optionally, party names). */
export type SubmittedTerms = {
  /** USDC base units as a decimal string. */
  amount: string;
  currency: string;
  /** Unix seconds. */
  dueDate: number;
  /** The reference as submitted: text, or a 32-byte hex hash of the text (then `hashRef` is needed). */
  buyerRef: string;
  sellerName?: string;
  buyerName?: string;
};

export type FieldMismatch = { field: keyof InvoiceFields; expected: string; found: string };

export type InvoiceVerification = { ok: boolean; mismatches: FieldMismatch[] };

export type VerifyOptions = {
  /** Hashes reference text; lets a hashed `buyerRef` be checked against the printed reference. */
  hashRef?: (text: string) => string;
};

const NOT_FOUND = "not found in the document";

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** `YYYY-MM-DD` of a unix-seconds timestamp in UTC. */
export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function refMatches(found: string, submitted: string, hashRef?: (text: string) => string): boolean {
  if (norm(found) === norm(submitted)) return true;
  const isHash = /^0x[0-9a-f]{64}$/i.test(submitted);
  return isHash && hashRef !== undefined && hashRef(found).toLowerCase() === submitted.toLowerCase();
}

/**
 * Amount, currency, due date and buyer reference must be printed on the document and equal the submitted terms
 * (the due date compares the UTC calendar day). Party names are compared only when both sides have one.
 */
export function verifyInvoiceFields(extracted: InvoiceFields, submitted: SubmittedTerms, options: VerifyOptions = {}): InvoiceVerification {
  const mismatches: FieldMismatch[] = [];
  const check = (field: keyof InvoiceFields, expected: string, matches: (found: string) => boolean, required: boolean) => {
    const found = extracted[field];
    if (found === undefined) {
      if (required) mismatches.push({ field, expected, found: NOT_FOUND });
    } else if (!matches(found)) {
      mismatches.push({ field, expected, found });
    }
  };

  check("amount", submitted.amount, (f) => f === submitted.amount, true);
  check("currency", submitted.currency, (f) => norm(f) === norm(submitted.currency), true);
  check("dueDate", isoDate(submitted.dueDate), (f) => f === isoDate(submitted.dueDate), true);
  check("buyerRef", submitted.buyerRef, (f) => refMatches(f, submitted.buyerRef, options.hashRef), true);
  if (submitted.sellerName) check("sellerName", submitted.sellerName, (f) => norm(f) === norm(submitted.sellerName!), false);
  if (submitted.buyerName) check("buyerName", submitted.buyerName, (f) => norm(f) === norm(submitted.buyerName!), false);
  return { ok: mismatches.length === 0, mismatches };
}
