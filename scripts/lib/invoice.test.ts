import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVOICE_PO_1003, INVOICE_PO_1003_PDF } from "../../agents/src/fixtures.js";
import { documentText, heuristicFields } from "../../apps/mcp-server/src/invoices/extract.js";
import { invoiceTerms, renderInvoicePdf, uploadArguments } from "./invoice.js";

const NOW = new Date(Date.UTC(2026, 10, 7, 9, 30));

describe("invoiceTerms", () => {
  it("prints the demo seller and buyer, the amount with two decimals and the due day", () => {
    expect(invoiceTerms({ buyerRef: "PO-2001", amount: "2", due: "2026-12-20" }, NOW)).toEqual({
      invoiceNumber: "INV-PO-2001",
      sellerName: INVOICE_PO_1003.sellerName,
      buyerName: INVOICE_PO_1003.buyerName,
      buyerRef: "PO-2001",
      currency: "USDC",
      amountPrinted: "2.00",
      amountUnits: 2_000_000n,
      dueDate: "2026-12-20",
      dueDateUnix: 1797768000n,
    });
  });

  it("defaults the due date to 30 days from now", () => {
    expect(invoiceTerms({ buyerRef: "PO-2001", amount: "2" }, NOW).dueDate).toBe("2026-12-07");
  });

  it("refuses a due date outside the registry's 1 to 120 day tenor", () => {
    expect(() => invoiceTerms({ buyerRef: "PO-2001", amount: "2", due: "2026-11-07" }, NOW)).toThrow(/1 and 120 days/);
    expect(() => invoiceTerms({ buyerRef: "PO-2001", amount: "2", due: "2027-04-01" }, NOW)).toThrow(/1 and 120 days/);
  });

  it("refuses a non-positive or over-precise amount and an odd reference", () => {
    expect(() => invoiceTerms({ buyerRef: "PO-2001", amount: "0" }, NOW)).toThrow(/amount/);
    expect(() => invoiceTerms({ buyerRef: "PO-2001", amount: "1.001" }, NOW)).toThrow(/amount/);
    expect(() => invoiceTerms({ buyerRef: "PO 2001;", amount: "2" }, NOW)).toThrow(/buyerRef/);
  });
});

describe("renderInvoicePdf", () => {
  it("reproduces the committed PO-1003 fixture byte for byte", async () => {
    const terms = { ...INVOICE_PO_1003, dueDateUnix: 0n };
    expect(Buffer.from(await renderInvoicePdf(terms)).equals(readFileSync(INVOICE_PO_1003_PDF))).toBe(true);
  });

  it("prints terms the MCP server's invoice reader recovers exactly", async () => {
    const terms = invoiceTerms({ buyerRef: "PO-2001", amount: "2.5", due: "2026-12-20" }, NOW);
    const fields = heuristicFields(await documentText(await renderInvoicePdf(terms), "application/pdf"));
    expect(fields).toMatchObject({ amount: "2500000", currency: "USDC", dueDate: "2026-12-20", buyerRef: "PO-2001" });
  });
});

describe("uploadArguments", () => {
  it("builds upload_invoice_document's arguments and upload_receivable's terms from the same invoice", () => {
    const terms = invoiceTerms({ buyerRef: "PO-2001", amount: "2", due: "2026-12-20" }, NOW);
    const pdf = new Uint8Array([37, 80, 68, 70]);
    expect(uploadArguments(terms, pdf)).toEqual({
      uploadInvoiceDocument: {
        receivableRef: "PO-2001",
        filename: "invoice-PO-2001.pdf",
        mime: "application/pdf",
        content: "JVBERg==",
        expected: { amount: "2000000", currency: "USDC", dueDate: 1797768000, buyerRef: "PO-2001" },
      },
      uploadReceivable: { amount: "2000000", dueDate: 1797768000, buyerRef: "PO-2001" },
    });
  });
});
