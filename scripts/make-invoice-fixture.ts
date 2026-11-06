/**
 * Generates `agents/fixtures/invoice-PO-1003.pdf`, the demo invoice the seller agent uploads. The PDF prints the
 * fields in `agents/src/fixtures.ts`. Run: `pnpm tsx scripts/make-invoice-fixture.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { INVOICE_PO_1003 as inv, INVOICE_PO_1003_PDF } from "../agents/src/fixtures.js";

const pdf = await PDFDocument.create();
// Fixed dates keep the file reproducible.
const EPOCH = new Date(Date.UTC(2026, 10, 6));
pdf.setCreationDate(EPOCH);
pdf.setModificationDate(EPOCH);
pdf.setTitle(`Invoice ${inv.invoiceNumber}`);
pdf.setProducer("CashETH demo fixture");

const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const page = pdf.addPage([595, 842]);

page.drawText("INVOICE", { x: 56, y: 770, size: 26, font: bold });
const lines = [
  `Invoice No: ${inv.invoiceNumber}`,
  `Seller: ${inv.sellerName}`,
  `Buyer: ${inv.buyerName}`,
  `Buyer PO Reference: ${inv.buyerRef}`,
  `Currency: ${inv.currency}`,
  `Amount Due: ${inv.currency} ${inv.amountPrinted}`,
  `Due Date: ${inv.dueDate}`,
  "Description: Research API credits (demo)",
];
lines.forEach((line, i) => page.drawText(line, { x: 56, y: 710 - i * 26, size: 13, font: regular }));
page.drawText("Payable on Hedera testnet through the CashETH RepaymentRouter.", { x: 56, y: 470, size: 10, font: regular });

mkdirSync(dirname(INVOICE_PO_1003_PDF), { recursive: true });
writeFileSync(INVOICE_PO_1003_PDF, await pdf.save({ useObjectStreams: false }));
console.log(`wrote ${INVOICE_PO_1003_PDF}`);
