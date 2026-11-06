/** A fresh invoice per run: a buyer reference never used before, so the receivable registers instead of `DUPLICATE_RECEIVABLE`. */
import { renderInvoicePdf } from "@casheth/agents";
import { parseUnits } from "viem";
import type { RunInvoice } from "./prompt.js";

const DAY_MS = 86_400_000;
/** Inside the registry's 1 to 120 day tenor window. */
const TENOR_DAYS = 30;

export interface FreshInvoice extends RunInvoice {
  filename: string;
  mime: "application/pdf";
  /** The PDF, base64. */
  content: string;
}

export async function freshInvoice({ now = new Date(), buyer, amountUsdc }: { now?: Date; buyer: string; amountUsdc: string }): Promise<FreshInvoice> {
  const buyerRef = `PO-${Math.floor(now.getTime() / 1000)}`;
  const dueDay = new Date(now.getTime() + TENOR_DAYS * DAY_MS).toISOString().slice(0, 10);
  const pdf = await renderInvoicePdf({
    invoiceNumber: `INV-${buyerRef}`,
    sellerName: "Acme Research Ltd",
    buyerName: "Globex Procurement Inc",
    buyerRef,
    currency: "USDC",
    amountPrinted: Number(amountUsdc).toFixed(2),
    dueDate: dueDay,
  });
  return {
    buyer,
    amount: parseUnits(amountUsdc, 6).toString(),
    // Noon UTC of the printed day: the server compares the UTC calendar day.
    dueDate: Date.parse(`${dueDay}T12:00:00Z`) / 1000,
    buyerRef,
    filename: `invoice-${buyerRef}.pdf`,
    mime: "application/pdf",
    content: Buffer.from(pdf).toString("base64"),
  };
}
