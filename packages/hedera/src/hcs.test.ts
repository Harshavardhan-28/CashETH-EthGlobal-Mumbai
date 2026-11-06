import { existsSync } from "node:fs";
import { HEDERA_IDS_PATH, loadEnv, loadHederaIds, type Env } from "@casheth/shared";
import type { Client } from "@hiero-ledger/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hieroClient } from "./client.js";
import { createAuditTopic, encodeAuditMessage, publishAudit, readAuditMessages, type AuditEvent } from "./hcs.js";
import { mirror, type MirrorTopicMessage } from "./mirror.js";

const probe = (prevSeq: number, n: number): AuditEvent => ({
  v: 1,
  type: "AgentRegistered",
  test: true,
  note: `hcs.test.ts probe ${n}`,
  prevSeq,
  ts: new Date().toISOString(),
});

describe("encodeAuditMessage", () => {
  it("serialises the event as JSON", () => {
    const event = probe(0, 1);
    expect(JSON.parse(encodeAuditMessage(event))).toEqual(event);
  });

  it("throws when the message exceeds 1024 bytes", () => {
    expect(() => encodeAuditMessage({ ...probe(0, 1), note: "x".repeat(1100) })).toThrow(/1024 bytes/);
  });
});

describe("readAuditMessages (stubbed mirror)", () => {
  afterEach(() => vi.restoreAllMocks());

  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const row = (seq: number, message: string, initial = true): MirrorTopicMessage => ({
    consensus_timestamp: `1793966863.${String(seq).padStart(9, "0")}`,
    message,
    sequence_number: seq,
    topic_id: "0.0.1",
    chunk_info: initial
      ? { initial_transaction_id: { account_id: "0.0.1001", transaction_valid_start: `1793966860.00000000${seq}` } }
      : null,
  });

  it("skips malformed base64, non-JSON and non-v1 messages and returns the rest oldest first", async () => {
    const good1 = probe(0, 1);
    const good2 = probe(1, 2);
    const stub = vi.spyOn(mirror, "topicMessages").mockResolvedValue([
      row(6, b64(JSON.stringify(good2)), false), // mirror returns newest first
      row(5, "%%%not-base64%%%"),
      row(4, b64("not json at all")),
      row(3, b64(JSON.stringify({ ...good1, v: 2 }))),
      row(2, b64("null")),
      row(1, b64(JSON.stringify(good1))),
    ]);

    const out = await readAuditMessages({} as Env, "0.0.1", { limit: 6 });

    expect(stub).toHaveBeenCalledWith({}, "0.0.1", { limit: 6, order: "desc" });
    expect(out.map((m) => m.sequenceNumber)).toEqual([1, 6]);
    expect(out[0]).toEqual({
      sequenceNumber: 1,
      consensusTimestamp: "1793966863.000000001",
      txId: "0.0.1001@1793966860.000000001",
      message: good1,
    });
    expect(out[1]?.message).toEqual(good2);
    expect(out[1]?.txId).toBeUndefined();
  });
});

// Live testnet suites run only with `LIVE=1` (they need .env): LIVE=1 pnpm -F @casheth/hedera test
describe.skipIf(!process.env.LIVE)("HCS audit topic (live testnet)", () => {
  let env: Env;
  let client: Client;
  let topicId: string;

  beforeAll(async () => {
    env = loadEnv();
    client = hieroClient(env);
    topicId = existsSync(HEDERA_IDS_PATH)
      ? loadHederaIds().hcsAuditTopicId
      : (await createAuditTopic(client, "CashETH audit test")).topicId;
  }, 60_000);

  afterAll(() => client?.close());

  it("publishAudit returns an increasing sequence number", async () => {
    const first = await publishAudit(client, topicId, probe(0, 1));
    const secondEvent = probe(first.sequenceNumber, 2);
    const second = await publishAudit(client, topicId, secondEvent);
    expect(first.sequenceNumber).toBeGreaterThan(0);
    expect(second.sequenceNumber).toBeGreaterThan(first.sequenceNumber);

    const found = await mirror.waitFor(
      async () =>
        (await readAuditMessages(env, topicId, { limit: 10 })).find(
          (m) => m.sequenceNumber === second.sequenceNumber,
        ),
      { attempts: 15, delayMs: 2000 },
    );
    expect(found.message).toEqual(secondEvent);
    expect(found.txId).toBe(second.txId);
    expect(found.consensusTimestamp).toMatch(/^\d+\.\d{9}$/);
  }, 90_000);
});
