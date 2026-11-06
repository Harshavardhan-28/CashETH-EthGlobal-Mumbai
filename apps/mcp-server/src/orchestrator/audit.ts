/**
 * Audit trail: every state change (and every rejection) is appended to the local `EventStore` and the same JSON is
 * published to the HCS audit topic (derived links trimmed first if it would not fit one 1024-byte message). HCS is
 * best-effort: a failed publish is recorded on the local event as `hcsError` and never fails the tool. Appends are
 * serialised so `seq` / `prevSeq` on HCS match the local store.
 */
import type { AuditEvent, AuditEventInput, EventStore } from "@casheth/engine";
import { enqueue } from "./queue.js";
import type { Orchestrator } from "./types.js";

/** Bigints become decimal strings, undefined fields are dropped (HCS messages are JSON, amounts as strings). */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as T;
}

const queues = new WeakMap<EventStore, Promise<unknown>>();

/** One HCS message holds at most 1024 bytes (`@casheth/hedera` `MAX_AUDIT_MESSAGE_BYTES`). */
export const HCS_MAX_BYTES = 1024;
/** Derived or caller-context fields dropped from the HCS copy, in this order, only when it would not fit. */
export const HCS_TRIM_ORDER = ["hashscan", "paymentHashscan", "decisionInputs", "jti", "agentUaid"] as const;

/**
 * The HCS copy of an event: the same JSON, minus derived links and caller context (in `HCS_TRIM_ORDER`) when the
 * full message would exceed one HCS chunk. The local event always keeps every field.
 */
export function hcsMessage<T extends Record<string, unknown>>(message: T): T {
  const out: Record<string, unknown> = { ...message };
  for (const key of HCS_TRIM_ORDER) {
    if (Buffer.byteLength(JSON.stringify(out), "utf8") <= HCS_MAX_BYTES) break;
    delete out[key];
  }
  return out as T;
}

async function append(o: Orchestrator, input: AuditEventInput): Promise<AuditEvent> {
  const body = jsonSafe(input);
  const prevSeq = o.events.last()?.seq ?? 0;
  const ts = body.ts ?? new Date(Number(o.now()) * 1000).toISOString();
  const message = { v: 1 as const, ...body, seq: prevSeq + 1, prevSeq, ts };

  let hcs: Record<string, unknown>;
  if (!o.hcs.topicId) {
    hcs = { hcsError: "HCS_AUDIT_TOPIC_ID is not configured" };
  } else {
    try {
      const { sequenceNumber, txId } = await o.hcs.publish(hcsMessage(message));
      hcs = { hcsSeq: sequenceNumber, hcsTxId: txId };
    } catch (err) {
      hcs = { hcsError: err instanceof Error ? err.message : String(err) };
      o.log("hcs publish failed", { type: body.type, error: hcs.hcsError });
    }
  }
  return o.events.append({ ...body, ts, ...hcs });
}

/** Appends one audit event (locally and to HCS); resolves with the stored event, never rejects on HCS errors. */
export function record(o: Orchestrator, input: AuditEventInput): Promise<AuditEvent> {
  return enqueue(queues, o.events, () => append(o, input));
}
