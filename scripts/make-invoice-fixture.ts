/**
 * Generates `agents/fixtures/invoice-PO-1003.pdf`, the demo invoice the seller agent uploads. The PDF prints the
 * fields in `agents/src/fixtures.ts`. Run: `pnpm tsx scripts/make-invoice-fixture.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INVOICE_PO_1003, INVOICE_PO_1003_PDF } from "../agents/src/fixtures.js";
import { renderInvoicePdf } from "../agents/src/invoicePdf.js";

mkdirSync(dirname(INVOICE_PO_1003_PDF), { recursive: true });
writeFileSync(INVOICE_PO_1003_PDF, await renderInvoicePdf(INVOICE_PO_1003));
console.log(`wrote ${INVOICE_PO_1003_PDF}`);
