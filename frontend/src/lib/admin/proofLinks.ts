import type { AuditEvent } from "./api";
import { shortAddress } from "./format";

const HASHSCAN = "https://hashscan.io/testnet";

/** One link a judge can click to verify part of an event on Hedera or against the stored invoice file. */
export type ProofLink = { label: string; url: string; text: string };

const str = (e: AuditEvent, key: string): string | undefined => (typeof e[key] === "string" && e[key] ? (e[key] as string) : undefined);

/** Every verifiable link an audit event carries, in the order a reader checks them. */
export function proofLinks(e: AuditEvent, hcsTopicId: string, apiUrl: string): ProofLink[] {
  const links: ProofLink[] = [];
  const txHash = str(e, "txHash");
  const txId = str(e, "txId");
  const main = str(e, "hashscan") ?? (txHash ? `${HASHSCAN}/transaction/${txHash}` : undefined);
  if (main) links.push({ label: txHash ? "EVM transaction" : "Hedera transaction", url: main, text: txHash ? shortAddress(txHash) : (txId ?? "HashScan") });

  const approve = str(e, "approveTxHash");
  if (approve) links.push({ label: "Settlement approval", url: `${HASHSCAN}/transaction/${approve}`, text: shortAddress(approve) });

  const payment = str(e, "paymentHashscan");
  if (payment) links.push({ label: "x402 payment", url: payment, text: txId ?? "HashScan" });

  const tokenId = str(e, "tokenId");
  if (tokenId && typeof e.serial === "number") links.push({ label: "Receivable NFT", url: `${HASHSCAN}/token/${tokenId}/${e.serial}`, text: `${tokenId} #${e.serial}` });

  const keccak = str(e, "keccak256") ?? str(e, "documentKeccak");
  if (keccak) links.push({ label: "Invoice document", url: `${apiUrl.replace(/\/+$/, "")}/invoices/${keccak}`, text: shortAddress(keccak) });

  if (typeof e.hcsSeq === "number") links.push({ label: "Hedera audit message", url: `${HASHSCAN}/topic/${hcsTopicId}/message/${e.hcsSeq}`, text: `${hcsTopicId} #${e.hcsSeq}` });
  return links;
}
