import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { receivableConfirmationTypedData, type ReceivableConfirmation } from "@casheth/shared";
import request from "supertest";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { INVOICE_PO_1003, INVOICE_PO_1003_DUE_UNIX, INVOICE_PO_1003_PDF } from "../../../../agents/src/fixtures.js";
import { fakeOrchestrator, kyaAgent, NOW, testApp, type TestOrchestrator } from "../test/fakes.js";
import { callTool } from "../test/rpc.js";
import { hashDocument } from "./hash.js";

const DAY = 86_400n;
const SELLER_SCOPES = "receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read";
const BUYER_SCOPES = "receivable:confirm receivable:read credit:read repay:write stats:read";

const seller = privateKeyToAccount(generatePrivateKey());
const otherSeller = getAddress("0x00000000000000000000000000000000000000c9");
const buyer = privateKeyToAccount(generatePrivateKey());

const pdf = readFileSync(INVOICE_PO_1003_PDF);
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");

/** A plain-text invoice due `days` after the fake chain's clock, in the format the heuristic reads. */
function textInvoice(amount: string, days: number, ref: string) {
  const due = new Date(Number(NOW + BigInt(days) * DAY) * 1000).toISOString().slice(0, 10);
  return `INVOICE\nSeller: Acme\nBuyer: Globex\nBuyer PO Reference: ${ref}\nCurrency: USDC\nAmount Due: USDC ${amount}\nDue Date: ${due}\n`;
}

async function setup() {
  const o = fakeOrchestrator();
  o.chain.agents.set(seller.address.toLowerCase(), kyaAgent(2, 1, "seller-co"));
  o.chain.agents.set(buyer.address.toLowerCase(), kyaAgent(3, 2, "buyer-co"));
  const t = await testApp(o);
  const tokens = {
    seller: await t.issuer.mint({ agent: seller.address, role: 1, level: 2, scope: SELLER_SCOPES }),
    otherSeller: await t.issuer.mint({ agent: otherSeller, role: 1, level: 2, scope: SELLER_SCOPES }),
    buyer: await t.issuer.mint({ agent: buyer.address, role: 2, level: 3, scope: BUYER_SCOPES }),
  };
  return { ...t, o: o as TestOrchestrator, tokens };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

let keySeq = 0;
const key = () => `invoice-key-${(keySeq += 1).toString().padStart(4, "0")}`;

const uploadDoc = (c: Ctx, content: Uint8Array | string, extra: Record<string, unknown> = {}, token = c.tokens.seller) =>
  callTool(c.app, token, "upload_invoice_document", {
    receivableRef: "PO-1003",
    filename: "invoice.pdf",
    mime: "application/pdf",
    content: b64(content),
    idempotencyKey: key(),
    ...extra,
  });

const uploadReceivable = (c: Ctx, args: Record<string, unknown>) =>
  callTool(c.app, c.tokens.seller, "upload_receivable", { buyer: buyer.address, idempotencyKey: key(), ...args });

async function signConfirmation(typed: { domain: Record<string, unknown>; message: Record<string, string> }): Promise<Hex> {
  const m = typed.message;
  const message: ReceivableConfirmation = {
    seller: m.seller as Address,
    buyer: m.buyer as Address,
    currency: m.currency as Address,
    amount: BigInt(m.amount!),
    dueDate: BigInt(m.dueDate!),
    buyerRef: m.buyerRef as Hex,
    detailsCommitment: m.detailsCommitment as Hex,
    payTo: m.payTo as Address,
    nonce: BigInt(m.nonce!),
    deadline: BigInt(m.deadline!),
  };
  const domain = { ...typed.domain, chainId: Number(typed.domain.chainId) } as Parameters<typeof receivableConfirmationTypedData>[0];
  return buyer.signTypedData(receivableConfirmationTypedData(domain, message));
}

/** Uploads a text invoice and its receivable, has the buyer confirm it, and returns the ids. */
async function registerWithDocument(c: Ctx) {
  const text = textInvoice("10000.00", 30, "PO-2001");
  const doc = (await uploadDoc(c, text, { mime: "text/plain", filename: "invoice.txt" })).json;
  const upload = await uploadReceivable(c, {
    amount: "10000000000",
    dueDate: Number(NOW + 30n * DAY),
    buyerRef: "PO-2001",
    documentKeccak: doc.keccak256,
  });
  const { pendingId, id, confirmationRequest } = upload.json as { pendingId: Hex; id: Hex; confirmationRequest: { typedData: Parameters<typeof signConfirmation>[0] } };
  const signature = await signConfirmation(confirmationRequest.typedData);
  const confirmed = await callTool(c.app, c.tokens.buyer, "confirm_receivable", { pendingId, signature, idempotencyKey: key() });
  return { keccak: doc.keccak256 as Hex, id, confirmed: confirmed.json, text };
}

describe("document hashing", () => {
  it("keccak256 and sha256 of the bytes; a single changed byte changes both", () => {
    const h = hashDocument(pdf);
    expect(h.keccak256).toBe(keccak256(pdf));
    expect(h.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    const tampered = Uint8Array.from(pdf);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) % 256;
    expect(hashDocument(tampered).keccak256).not.toBe(h.keccak256);
    expect(hashDocument(tampered).sha256).not.toBe(h.sha256);
  });
});

describe("upload_invoice_document", () => {
  it("stores the PDF, reads its fields, anchors the hashes on HCS and serves the exact bytes", async () => {
    const c = await setup();
    const { result, json } = await uploadDoc(c, pdf);
    expect(result.isError).toBeUndefined();
    const hashes = hashDocument(pdf);
    expect(json).toMatchObject({
      keccak256: hashes.keccak256,
      sha256: hashes.sha256,
      bytes: pdf.length,
      mime: "application/pdf",
      extractor: "heuristic",
      extracted: { amount: "6000000", currency: "USDC", dueDate: INVOICE_PO_1003.dueDate, buyerRef: "PO-1003" },
      verification: null,
      hcsSeq: 1,
      downloadPath: `/invoices/${hashes.keccak256}`,
    });
    expect(json.hashscan).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\//);

    expect(c.o.hcsPublished).toHaveLength(1);
    expect(c.o.hcsPublished[0]).toMatchObject({
      type: "InvoiceDocumentStored",
      receivableRef: "PO-1003",
      sha256: hashes.sha256,
      keccak256: hashes.keccak256,
      bytes: pdf.length,
      mime: "application/pdf",
    });

    const served = await request(c.app).get(`/invoices/${hashes.keccak256}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("application/pdf");
    expect(keccak256(served.body as Buffer)).toBe(hashes.keccak256);
  });

  it("returns the field verification when `expected` is given", async () => {
    const c = await setup();
    const terms = { amount: "6000000", dueDate: Number(INVOICE_PO_1003_DUE_UNIX), buyerRef: "PO-1003" };
    expect((await uploadDoc(c, pdf, { expected: terms })).json.verification).toEqual({ ok: true, mismatches: [] });
    const wrong = await uploadDoc(c, pdf, { expected: { ...terms, amount: "7000000" } });
    expect(wrong.json.verification).toEqual({ ok: false, mismatches: [{ field: "amount", expected: "7000000", found: "6000000" }] });
  });

  it("a repeat upload by the same seller is not recorded twice; another seller is refused", async () => {
    const c = await setup();
    const first = await uploadDoc(c, pdf);
    const again = await uploadDoc(c, pdf);
    expect(again.json.keccak256).toBe(first.json.keccak256);
    expect(c.o.hcsPublished).toHaveLength(1);
    expect((await uploadDoc(c, pdf, {}, c.tokens.otherSeller)).json).toMatchObject({ code: "NOT_PARTY" });
  });

  it("rejects a non-PDF, non-base64 and an oversized file", async () => {
    const c = await setup();
    expect((await uploadDoc(c, "not a pdf at all")).json).toMatchObject({ code: "BAD_INPUT", message: "the file is not a PDF" });
    expect((await uploadDoc(c, "x", { content: "***" })).json).toMatchObject({ code: "BAD_INPUT" });
    const big = await uploadDoc(c, Buffer.alloc(2 * 1024 * 1024 + 1, 65), { mime: "text/plain" });
    expect(big.json).toMatchObject({ code: "BAD_INPUT" });
    expect(c.o.hcsPublished).toHaveLength(0);
  });

  it("accepts a document of exactly 2 MB", async () => {
    const c = await setup();
    const text = Buffer.alloc(2 * 1024 * 1024, 32);
    text.write(textInvoice("1.00", 30, "PO-9"));
    const { result } = await uploadDoc(c, text, { mime: "text/plain", filename: "big.txt" });
    expect(result.isError).toBeUndefined();
  });

  it("copies the document to HFS when enabled, and survives an HFS failure", async () => {
    const c = await setup();
    c.o.hfs = { store: async () => ({ fileId: "0.0.9999", txIds: ["0.0.1@1.1"] }) };
    const ok = await uploadDoc(c, pdf);
    expect(ok.json.hfsFileId).toBe("0.0.9999");
    expect(c.o.hcsPublished[0]).toMatchObject({ hfsFileId: "0.0.9999" });

    c.o.hfs = { store: async () => Promise.reject(new Error("HFS down")) };
    const failed = await uploadDoc(c, textInvoice("2.00", 30, "PO-8"), { mime: "text/plain", filename: "b.txt" });
    expect(failed.result.isError).toBeUndefined();
    expect(failed.json).toMatchObject({ hfsError: "HFS down" });
    expect(failed.json.hfsFileId).toBeUndefined();
  });

  it("is seller-only", async () => {
    const c = await setup();
    expect((await uploadDoc(c, pdf, {}, c.tokens.buyer)).json).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });
});

describe("upload_receivable with documentKeccak", () => {
  const terms = { amount: "6000000", dueDate: Number(INVOICE_PO_1003_DUE_UNIX), buyerRef: "PO-1003" };

  it("commits to the document hash and records the link on the audit event", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    const { json, result } = await uploadReceivable(c, { ...terms, documentKeccak: doc.keccak256 });
    expect(result.isError).toBeUndefined();
    const typed = (json.confirmationRequest as { typedData: { message: { detailsCommitment: string } } }).typedData;
    expect(typed.message.detailsCommitment).toBe(doc.keccak256);
    expect(c.o.events.list().find((e) => e.type === "ReceivableUploaded")).toMatchObject({ documentKeccak: doc.keccak256 });
  });

  it("refuses terms that differ from the document with INVOICE_MISMATCH and records the rejection", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    const { json } = await uploadReceivable(c, { ...terms, amount: "9000000", documentKeccak: doc.keccak256 });
    expect(json).toMatchObject({ code: "INVOICE_MISMATCH", mismatches: [{ field: "amount", expected: "9000000", found: "6000000" }] });
    expect(c.o.events.list().find((e) => e.type === "ReceivableRejected")).toMatchObject({ code: "INVOICE_MISMATCH", stage: "upload" });
    expect(c.o.events.list().some((e) => e.type === "ReceivableUploaded")).toBe(false);
  });

  it("needs a stored document of this seller, and one of documentKeccak or detailsCommitment", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    expect((await uploadReceivable(c, { ...terms, documentKeccak: keccak256(toHex("nothing")) })).json).toMatchObject({ code: "NOT_FOUND" });
    const stolen = await callTool(c.app, c.tokens.otherSeller, "upload_receivable", { ...terms, buyer: buyer.address, documentKeccak: doc.keccak256, idempotencyKey: key() });
    expect(stolen.json).toMatchObject({ code: "NOT_PARTY" });
    expect((await uploadReceivable(c, terms)).json).toMatchObject({ code: "BAD_INPUT" });
    expect((await uploadReceivable(c, { ...terms, documentKeccak: doc.keccak256, detailsCommitment: keccak256(toHex("other")) })).json).toMatchObject({ code: "BAD_INPUT" });
  });

  it("checks a stored document named as detailsCommitment exactly like documentKeccak", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    const stolen = await callTool(c.app, c.tokens.otherSeller, "upload_receivable", { ...terms, buyer: buyer.address, detailsCommitment: doc.keccak256, idempotencyKey: key() });
    expect(stolen.json).toMatchObject({ code: "NOT_PARTY" });
    const { json } = await uploadReceivable(c, { ...terms, amount: "9000000", detailsCommitment: doc.keccak256 });
    expect(json).toMatchObject({ code: "INVOICE_MISMATCH", mismatches: [{ field: "amount", expected: "9000000", found: "6000000" }] });
    const ok = await uploadReceivable(c, { ...terms, detailsCommitment: doc.keccak256 });
    expect(ok.result.isError).toBeUndefined();
    expect(c.o.events.list().find((e) => e.type === "ReceivableUploaded")).toMatchObject({ documentKeccak: doc.keccak256 });
  });

  it("still accepts a bare detailsCommitment (no document)", async () => {
    const c = await setup();
    const { result } = await uploadReceivable(c, { ...terms, detailsCommitment: keccak256(toHex("invoice-doc")) });
    expect(result.isError).toBeUndefined();
  });

  it("matches a hashed buyerRef against the printed reference", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    const { result } = await uploadReceivable(c, { ...terms, buyerRef: keccak256(toHex("PO-1003")), documentKeccak: doc.keccak256 });
    expect(result.isError).toBeUndefined();
  });
});

describe("on-chain verification", () => {
  it("confirm_receivable, get_receivable_status, get_invoice_document and GET /receivables/:id show the document as verified", async () => {
    const c = await setup();
    const { keccak, id, confirmed } = await registerWithDocument(c);
    expect(confirmed).toMatchObject({ document: { keccak, verified: true } });
    expect(c.o.chain.receivables.get(id.toLowerCase())?.detailsCommitment).toBe(keccak);

    const status = await callTool(c.app, c.tokens.seller, "get_receivable_status", { id });
    expect(status.json).toMatchObject({ document: { keccak, verified: true } });
    const doc = await callTool(c.app, c.tokens.buyer, "get_invoice_document", { keccak });
    expect(doc.json).toMatchObject({
      keccak256: keccak,
      verification: { storedHashMatches: true, onChain: { receivableId: id, registered: true, commitment: keccak, matches: true } },
    });
    const read = await request(c.app).get(`/receivables/${id}`);
    expect(read.body.document).toEqual({ keccak, verified: true });
  });

  it("a pending receivable lists its document as not yet verified", async () => {
    const c = await setup();
    const doc = (await uploadDoc(c, pdf)).json;
    const { json } = await uploadReceivable(c, { amount: "6000000", dueDate: Number(INVOICE_PO_1003_DUE_UNIX), buyerRef: "PO-1003", documentKeccak: doc.keccak256 });
    const status = await callTool(c.app, c.tokens.seller, "get_receivable_status", { id: json.id });
    expect(status.json).toMatchObject({ state: "Pending", document: { keccak: doc.keccak256, verified: false } });
    const stored = await callTool(c.app, c.tokens.seller, "get_invoice_document", { keccak: doc.keccak256 });
    expect(stored.json).toMatchObject({ verification: { storedHashMatches: true, onChain: { registered: false } } });
  });

  it("a tampered stored file no longer verifies, and the served bytes hash differently", async () => {
    const c = await setup();
    const { keccak, id, text } = await registerWithDocument(c);
    const path = c.o.invoices.filePath(c.o.invoices.meta(keccak)!);
    writeFileSync(path, text.replace("10000.00", "99999.00"));

    const status = await callTool(c.app, c.tokens.seller, "get_receivable_status", { id });
    expect(status.json).toMatchObject({ document: { keccak, verified: false } });
    const doc = await callTool(c.app, c.tokens.seller, "get_invoice_document", { keccak });
    expect(doc.json).toMatchObject({ verification: { storedHashMatches: false, onChain: { matches: true } } });
    const served = await request(c.app).get(`/invoices/${keccak}`);
    expect(keccak256(toHex(served.text))).not.toBe(keccak);
  });

  it("upload_receivable refuses a document whose stored bytes were tampered with", async () => {
    const c = await setup();
    const text = textInvoice("5.00", 30, "PO-7");
    const doc = (await uploadDoc(c, text, { mime: "text/plain", filename: "t.txt" })).json;
    writeFileSync(c.o.invoices.filePath(c.o.invoices.meta(doc.keccak256 as Hex)!), text.replace("5.00", "5000.00"));
    const { json } = await uploadReceivable(c, { amount: "5000000", dueDate: Number(NOW + 30n * DAY), buyerRef: "PO-7", documentKeccak: doc.keccak256 });
    expect(json).toMatchObject({ code: "INVOICE_MISMATCH", message: "the stored document no longer matches its hash" });
  });

  it("get_invoice_document and GET /invoices answer NOT_FOUND / 400 for unknown or malformed hashes", async () => {
    const c = await setup();
    expect((await callTool(c.app, c.tokens.seller, "get_invoice_document", { keccak: keccak256(toHex("x")) })).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await request(c.app).get(`/invoices/${keccak256(toHex("x"))}`)).status).toBe(404);
    expect((await request(c.app).get("/invoices/not-a-hash")).status).toBe(400);
  });
});
