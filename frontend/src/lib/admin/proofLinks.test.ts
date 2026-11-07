import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./api";
import { proofLinks } from "./proofLinks";

const TOPIC = "0.0.11338927";
const API = "http://localhost:4030";
const event = (fields: Partial<AuditEvent>): AuditEvent => ({ seq: 1, ts: 0, type: "Repaid", ...fields }) as AuditEvent;
const labels = (e: AuditEvent) => proofLinks(e, TOPIC, API).map((l) => [l.label, l.url]);

describe("proofLinks", () => {
  it("links a Repaid event's settlement, its approval and its audit message", () => {
    const e = event({
      type: "Repaid",
      txHash: "0xc42dbcde503e177cf8c99d980dc9f20a774138e64515adfba953e72501283194",
      hashscan: "https://hashscan.io/testnet/transaction/0xc42dbcde503e177cf8c99d980dc9f20a774138e64515adfba953e72501283194",
      approveTxHash: "0x2c4fe3c34f235ac1cfefa2ab028200f1fa37cd4faeb414b5de471573bf71e3a6",
      hcsSeq: 123,
    });
    expect(labels(e)).toEqual([
      ["EVM transaction", "https://hashscan.io/testnet/transaction/0xc42dbcde503e177cf8c99d980dc9f20a774138e64515adfba953e72501283194"],
      ["Settlement approval", "https://hashscan.io/testnet/transaction/0x2c4fe3c34f235ac1cfefa2ab028200f1fa37cd4faeb414b5de471573bf71e3a6"],
      ["Hedera audit message", "https://hashscan.io/testnet/topic/0.0.11338927/message/123"],
    ]);
  });

  it("links a minted note's Hedera transaction and the NFT itself", () => {
    const e = event({
      type: "NftMinted",
      txId: "0.0.11333252@1794016274.607475076",
      hashscan: "https://hashscan.io/testnet/transaction/0.0.11333252@1794016274.607475076",
      tokenId: "0.0.11338934",
      serial: 8,
    });
    expect(labels(e)).toEqual([
      ["Hedera transaction", "https://hashscan.io/testnet/transaction/0.0.11333252@1794016274.607475076"],
      ["Receivable NFT", "https://hashscan.io/testnet/token/0.0.11338934/8"],
    ]);
  });

  it("links the x402 payment next to the spend commit", () => {
    const e = event({
      type: "SpendCommitted",
      txHash: "0x087d74e2d8956545fe1ce977d0fe7d0d949ee9b6e0e2eb98a258fc7fd9c35bf5",
      txId: "0.0.9185802@1794016452.965527617",
      paymentHashscan: "https://hashscan.io/testnet/transaction/0.0.9185802@1794016452.965527617",
    });
    expect(labels(e)).toContainEqual(["x402 payment", "https://hashscan.io/testnet/transaction/0.0.9185802@1794016452.965527617"]);
  });

  it("links the stored invoice document by its hash", () => {
    const keccak = "0x" + "ab".repeat(32);
    expect(labels(event({ type: "InvoiceDocumentStored", keccak256: keccak }))).toEqual([["Invoice document", `${API}/invoices/${keccak}`]]);
    expect(labels(event({ type: "ReceivableUploaded", documentKeccak: keccak }))).toEqual([["Invoice document", `${API}/invoices/${keccak}`]]);
  });

  it("returns nothing for an event without proof", () => {
    expect(proofLinks(event({ type: "SpendRejected" }), TOPIC, API)).toEqual([]);
  });
});
