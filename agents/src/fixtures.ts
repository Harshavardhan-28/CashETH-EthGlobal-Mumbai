/** The demo invoice document for receivable PO-1003 (`pnpm tsx scripts/make-invoice-fixture.ts` regenerates the PDF). */
import { fileURLToPath } from "node:url";

/** Absolute path of the committed PDF (the same relative path works from `src` and from `dist`). */
export const INVOICE_PO_1003_PDF = fileURLToPath(new URL("../fixtures/invoice-PO-1003.pdf", import.meta.url));

/** What the PDF prints; the demo's `upload_receivable` terms must equal these. */
export const INVOICE_PO_1003 = {
  invoiceNumber: "INV-2026-0042",
  sellerName: "Acme Research Ltd",
  buyerName: "Globex Procurement Inc",
  buyerRef: "PO-1003",
  currency: "USDC",
  /** 6.00 USDC in base units, the size of the PO-1002 demo receivable. */
  amountUnits: 6_000_000n,
  amountPrinted: "6.00",
  /** UTC calendar day printed as the due date; inside the registry's 1 to 120 day window until 2026-12-19. */
  dueDate: "2026-12-20",
} as const;

/** Unix seconds of the due date (midnight UTC), for `upload_receivable`'s `dueDate`. */
export const INVOICE_PO_1003_DUE_UNIX = BigInt(Date.parse(`${INVOICE_PO_1003.dueDate}T12:00:00Z`) / 1000);
