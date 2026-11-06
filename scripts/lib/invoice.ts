/**
 * Demo invoice PDFs: the committed PO-1003 fixture and fresh ones for a new buyer reference (the Claude Code
 * walkthrough uploads a new invoice each run). The PDF prints the labelled fields the MCP server's invoice reader
 * parses, so `upload_invoice_document` verifies them and `upload_receivable` must use the same terms.
 */
import { parseUnits } from "viem";
import { INVOICE_PO_1003 } from "../../agents/src/fixtures.js";

/** One renderer for every demo invoice: the fixture, fresh CLI invoices and the seller agent's. */
export { renderInvoicePdf } from "../../agents/src/invoicePdf.js";

const DAY_MS = 86_400_000;
/** The registry accepts a tenor of 1 to 120 days. */
const MIN_TENOR_DAYS = 1;
const MAX_TENOR_DAYS = 120;
const DEFAULT_TENOR_DAYS = 30;

export interface InvoiceTerms {
  invoiceNumber: string;
  sellerName: string;
  buyerName: string;
  buyerRef: string;
  currency: string;
  amountPrinted: string;
  amountUnits: bigint;
  /** UTC day printed as the due date, `YYYY-MM-DD`. */
  dueDate: string;
  /** Noon UTC of the due day, unix seconds (what `upload_receivable` takes). */
  dueDateUnix: bigint;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Terms of a fresh demo invoice: the demo seller and buyer, `amount` USDC, due on `due` (default in 30 days). */
export function invoiceTerms(input: { buyerRef: string; amount: string; due?: string }, now = new Date()): InvoiceTerms {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(input.buyerRef)) throw new Error(`buyerRef "${input.buyerRef}" must be 1-32 letters, digits, ".", "_" or "-"`);
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount) || parseUnits(input.amount, 6) === 0n) {
    throw new Error(`amount "${input.amount}" must be a positive USDC amount with at most two decimals`);
  }
  const dueDate = input.due ?? isoDay(now.getTime() + DEFAULT_TENOR_DAYS * DAY_MS);
  const dueMs = Date.parse(`${dueDate}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(dueMs)) throw new Error(`due "${dueDate}" must be a YYYY-MM-DD date`);
  const tenorDays = (dueMs - now.getTime()) / DAY_MS;
  if (tenorDays < MIN_TENOR_DAYS || tenorDays > MAX_TENOR_DAYS) {
    throw new Error(`due ${dueDate} must be between ${MIN_TENOR_DAYS} and ${MAX_TENOR_DAYS} days from now (registry tenor)`);
  }
  const amountUnits = parseUnits(input.amount, 6);
  return {
    invoiceNumber: `INV-${input.buyerRef}`,
    sellerName: INVOICE_PO_1003.sellerName,
    buyerName: INVOICE_PO_1003.buyerName,
    buyerRef: input.buyerRef,
    currency: "USDC",
    amountPrinted: (Number(amountUnits) / 1e6).toFixed(2),
    amountUnits,
    dueDate,
    dueDateUnix: BigInt(dueMs / 1000),
  };
}

/** `upload_invoice_document`'s arguments and the matching `upload_receivable` terms (add buyer and documentKeccak). */
export function uploadArguments(terms: InvoiceTerms, pdf: Uint8Array) {
  const dueDate = Number(terms.dueDateUnix);
  const amount = terms.amountUnits.toString();
  return {
    uploadInvoiceDocument: {
      receivableRef: terms.buyerRef,
      filename: `invoice-${terms.buyerRef}.pdf`,
      mime: "application/pdf",
      content: Buffer.from(pdf).toString("base64"),
      expected: { amount, currency: terms.currency, dueDate, buyerRef: terms.buyerRef },
    },
    uploadReceivable: { amount, dueDate, buyerRef: terms.buyerRef },
  };
}
