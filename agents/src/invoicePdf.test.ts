import { PDFParse } from "pdf-parse";
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "./invoicePdf.js";

async function textOf(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe("renderInvoicePdf", () => {
  it("prints the labelled fields the MCP server's invoice reader looks for", async () => {
    const bytes = await renderInvoicePdf({
      invoiceNumber: "INV-7",
      sellerName: "Acme Research Ltd",
      buyerName: "Globex Procurement Inc",
      buyerRef: "PO-1762500000",
      currency: "USDC",
      amountPrinted: "2.00",
      dueDate: "2026-12-07",
    });

    const text = await textOf(bytes);
    expect(text).toContain("Buyer PO Reference: PO-1762500000");
    expect(text).toContain("Amount Due: USDC 2.00");
    expect(text).toContain("Due Date: 2026-12-07");
    expect(text).toContain("Invoice No: INV-7");
    expect(text).toContain("Seller: Acme Research Ltd");
  });
});
