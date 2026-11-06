import { describe, expect, it } from "vitest";
import { isoDate, verifyInvoiceFields, type InvoiceFields, type SubmittedTerms } from "./invoice.js";

const DUE = Date.UTC(2026, 11, 20, 15, 30) / 1000;
const submitted: SubmittedTerms = { amount: "6000000", currency: "USDC", dueDate: DUE, buyerRef: "PO-1003" };
const extracted: InvoiceFields = { amount: "6000000", currency: "USDC", dueDate: "2026-12-20", buyerRef: "po-1003" };

describe("verifyInvoiceFields", () => {
  it("accepts a document that matches the submitted terms (case-insensitive reference, due day in UTC)", () => {
    expect(verifyInvoiceFields(extracted, submitted)).toEqual({ ok: true, mismatches: [] });
  });

  it("reports every differing field with what was expected and found", () => {
    const result = verifyInvoiceFields({ ...extracted, amount: "7000000", dueDate: "2026-12-21", buyerRef: "PO-9" }, submitted);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { field: "amount", expected: "6000000", found: "7000000" },
      { field: "dueDate", expected: "2026-12-20", found: "2026-12-21" },
      { field: "buyerRef", expected: "PO-1003", found: "PO-9" },
    ]);
  });

  it("requires amount, currency, due date and reference to be on the document", () => {
    const result = verifyInvoiceFields({}, submitted);
    expect(result.mismatches.map((m) => m.field)).toEqual(["amount", "currency", "dueDate", "buyerRef"]);
    expect(result.mismatches.every((m) => m.found === "not found in the document")).toBe(true);
  });

  it("checks names only when both sides have one", () => {
    expect(verifyInvoiceFields({ ...extracted, sellerName: "Acme" }, submitted).ok).toBe(true);
    expect(verifyInvoiceFields(extracted, { ...submitted, buyerName: "Globex" }).ok).toBe(true);
    expect(verifyInvoiceFields({ ...extracted, sellerName: "Acme  Research" }, { ...submitted, sellerName: "ACME research" }).ok).toBe(true);
    const bad = verifyInvoiceFields({ ...extracted, buyerName: "Initech" }, { ...submitted, buyerName: "Globex" });
    expect(bad.mismatches[0]).toMatchObject({ field: "buyerName" });
  });

  it("checks a hashed reference through hashRef", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const hashRef = (t: string) => (t === "PO-1003" ? hash : "0x00");
    expect(verifyInvoiceFields({ ...extracted, buyerRef: "PO-1003" }, { ...submitted, buyerRef: hash }, { hashRef }).ok).toBe(true);
    expect(verifyInvoiceFields({ ...extracted, buyerRef: "PO-1003" }, { ...submitted, buyerRef: hash }).ok).toBe(false);
    expect(verifyInvoiceFields({ ...extracted, buyerRef: "PO-1" }, { ...submitted, buyerRef: hash }, { hashRef }).ok).toBe(false);
  });

  it("isoDate is the UTC calendar day", () => {
    expect(isoDate(Date.UTC(2026, 0, 1, 23, 59, 59) / 1000)).toBe("2026-01-01");
  });
});
