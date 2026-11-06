import { PDFParse } from "pdf-parse";
import { describe, expect, it } from "vitest";
import { freshInvoice } from "./invoice.js";

const BUYER = "0x00000000000000000000000000000000000000b1";
const NOW = new Date(Date.UTC(2026, 10, 7, 1, 30)); // 2026-11-07T01:30Z, unix 1794015000

async function textOf(base64: string): Promise<string> {
  const parser = new PDFParse({ data: Buffer.from(base64, "base64") });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe("freshInvoice", () => {
  it("uses a buyer reference never used before (PO-<unix seconds>), so the receivable registers fresh", async () => {
    const invoice = await freshInvoice({ now: NOW, buyer: BUYER, amountUsdc: "2.00" });
    expect(invoice.buyerRef).toBe("PO-1794015000");
    expect(invoice.filename).toBe("invoice-PO-1794015000.pdf");
  });

  it("prints exactly the terms upload_receivable will submit: amount, due day 30 days out and buyer reference", async () => {
    const invoice = await freshInvoice({ now: NOW, buyer: BUYER, amountUsdc: "2.00" });

    expect(invoice).toMatchObject({ buyer: BUYER, amount: "2000000", mime: "application/pdf" });
    expect(new Date(invoice.dueDate * 1000).toISOString().slice(0, 10)).toBe("2026-12-07");
    const text = await textOf(invoice.content);
    expect(text).toContain("Buyer PO Reference: PO-1794015000");
    expect(text).toContain("Amount Due: USDC 2.00");
    expect(text).toContain("Due Date: 2026-12-07");
  });
});
