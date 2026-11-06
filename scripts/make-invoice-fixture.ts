/**
 * Demo invoice PDFs.
 *
 *   pnpm tsx scripts/make-invoice-fixture.ts
 *     regenerates `agents/fixtures/invoice-PO-1003.pdf`, the committed demo invoice (fields in `agents/src/fixtures.ts`).
 *
 *   pnpm -s tsx scripts/make-invoice-fixture.ts --buyer-ref PO-2001 [--amount 2.00] [--due YYYY-MM-DD] [--out file]
 *     writes a fresh invoice (default `agents/data/invoices/invoice-<ref>.pdf`, gitignored; due in 30 days by default)
 *     and prints JSON: the `upload_invoice_document` arguments (base64 content and `expected` terms) and the
 *     `upload_receivable` terms that must match them (add `buyer` and the returned `documentKeccak`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { INVOICE_PO_1003, INVOICE_PO_1003_PDF } from "../agents/src/fixtures.js";
import { invoiceTerms, renderInvoicePdf, uploadArguments } from "./lib/invoice.js";

const { values } = parseArgs({
  options: { "buyer-ref": { type: "string" }, amount: { type: "string", default: "2.00" }, due: { type: "string" }, out: { type: "string" } },
});

function write(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

const buyerRef = values["buyer-ref"];
if (!buyerRef) {
  write(INVOICE_PO_1003_PDF, await renderInvoicePdf(INVOICE_PO_1003));
  console.log(`wrote ${INVOICE_PO_1003_PDF}`);
} else {
  const terms = invoiceTerms({ buyerRef, amount: values.amount, ...(values.due ? { due: values.due } : {}) });
  const file = values.out ?? fileURLToPath(new URL(`../agents/data/invoices/invoice-${buyerRef}.pdf`, import.meta.url));
  const pdf = await renderInvoicePdf(terms);
  write(file, pdf);
  console.log(JSON.stringify({ file, dueDate: terms.dueDate, ...uploadArguments(terms, pdf) }, null, 2));
}
