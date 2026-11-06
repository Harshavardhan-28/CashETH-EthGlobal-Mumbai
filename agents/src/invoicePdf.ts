/** Renders a one-page demo invoice whose labelled lines the MCP server's invoice reader extracts (docs/API.md `upload_invoice_document`). */
import { PDFDocument, StandardFonts } from "pdf-lib";

export interface InvoiceFields {
  invoiceNumber: string;
  sellerName: string;
  buyerName: string;
  buyerRef: string;
  currency: string;
  /** Decimal USDC as printed, e.g. "6.00". */
  amountPrinted: string;
  /** UTC calendar day, YYYY-MM-DD. */
  dueDate: string;
}

/** Fixed dates keep the file reproducible: the same fields always give the same bytes (and keccak256). */
const EPOCH = new Date(Date.UTC(2026, 10, 6));

export async function renderInvoicePdf(inv: InvoiceFields): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
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

  return pdf.save({ useObjectStreams: false });
}
