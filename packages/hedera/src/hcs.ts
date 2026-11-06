import type { Env } from "@casheth/shared";
import { TopicCreateTransaction, TopicMessageSubmitTransaction, type Client } from "@hiero-ledger/sdk";
import { executeForReceipt } from "./execute.js";
import { mirror } from "./mirror.js";

/** BUILD.md §12.1. The engine package defines the same union separately; keep them identical. */
export type AuditType =
  | "AgentRegistered"
  | "ReceivableUploaded"
  | "ReceivableConfirmed"
  | "ReceivableRejected"
  | "NftMinted"
  | "StrategyShipped"
  | "StrategyDocked"
  | "FacilityFunded"
  | "BudgetsSet"
  | "SpendReserved"
  | "SpendCommitted"
  | "SpendReleased"
  | "SpendRejected"
  | "Repaid"
  | "Overdue"
  | "Defaulted"
  | "Disputed";

/** One HCS audit message: JSON, hashes and ids only, never personal data or keys. */
export type AuditEvent = {
  v: 1;
  type: AuditType;
  id?: string;
  spendId?: string;
  agentUaid?: string;
  amount?: string;
  asset?: string;
  merchant?: string;
  txId?: string;
  prevSeq: number;
  ts: string;
  [k: string]: unknown;
};

/** A single HCS chunk; larger payloads would be split into several messages, which we never want. */
export const MAX_AUDIT_MESSAGE_BYTES = 1024;

/** JSON of the event; throws when it would not fit in one HCS message. */
export function encodeAuditMessage(event: AuditEvent): string {
  const json = JSON.stringify(event);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_AUDIT_MESSAGE_BYTES) {
    throw new Error(
      `Audit message for ${event.type} is ${bytes} bytes; HCS messages must be at most ${MAX_AUDIT_MESSAGE_BYTES} bytes`,
    );
  }
  return json;
}

/** Creates the audit topic. Its submit key is the operator's, so only our orchestrator can write to it. */
export async function createAuditTopic(
  client: Client,
  memo = "CashETH audit v1",
): Promise<{ topicId: string; txId: string }> {
  const operatorKey = client.operatorPublicKey;
  if (!operatorKey) throw new Error("createAuditTopic: client has no operator");
  const { receipt, txId } = await executeForReceipt(
    client,
    new TopicCreateTransaction().setTopicMemo(memo).setSubmitKey(operatorKey),
  );
  if (!receipt.topicId) throw new Error("Topic creation returned no topic id");
  return { topicId: receipt.topicId.toString(), txId };
}

/** Submits one audit event; the client's operator must hold the topic's submit key. */
export async function publishAudit(
  client: Client,
  topicId: string,
  event: AuditEvent,
): Promise<{ sequenceNumber: number; txId: string }> {
  const message = encodeAuditMessage(event);
  const { receipt, txId } = await executeForReceipt(
    client,
    new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message),
  );
  if (!receipt.topicSequenceNumber) throw new Error(`Submit to ${topicId} returned no sequence number`);
  return { sequenceNumber: receipt.topicSequenceNumber.toNumber(), txId };
}

export interface AuditMessage {
  sequenceNumber: number;
  consensusTimestamp: string;
  /** Submitting transaction id (`0.0.x@seconds.nanos`) when the mirror reports it. */
  txId?: string;
  message: AuditEvent;
}

/**
 * The latest `limit` audit messages from the mirror node, oldest first. Messages that are not
 * version-1 audit JSON are skipped (the submit key makes that unlikely, but the mirror is untrusted).
 */
export async function readAuditMessages(
  env: Env,
  topicId: string,
  { limit = 25 }: { limit?: number } = {},
): Promise<AuditMessage[]> {
  const raw = await mirror.topicMessages(env, topicId, { limit, order: "desc" });
  const out: AuditMessage[] = [];
  for (const m of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) continue;
    const initial = m.chunk_info?.initial_transaction_id;
    out.push({
      sequenceNumber: m.sequence_number,
      consensusTimestamp: m.consensus_timestamp,
      ...(initial ? { txId: `${initial.account_id}@${initial.transaction_valid_start}` } : {}),
      message: parsed as AuditEvent,
    });
  }
  return out.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
