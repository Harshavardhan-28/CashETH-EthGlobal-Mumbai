import { existsSync } from "node:fs";
import { HEDERA_IDS_PATH, loadEnv, loadHederaIds } from "@casheth/shared";
import type { Client } from "@hiero-ledger/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hieroClient } from "./client.js";
import { createAuditTopic, encodeAuditMessage, publishAudit, readAuditMessages, type AuditEvent } from "./hcs.js";
import { mirror } from "./mirror.js";

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

describe("HCS audit topic (live testnet)", () => {
  const env = loadEnv();
  let client: Client;
  let topicId: string;

  beforeAll(async () => {
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
