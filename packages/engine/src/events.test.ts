import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "./events.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-events-"));
  file = join(dir, "nested", "data", "events.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("starts empty and creates the parent directory on first append", () => {
    const store = new EventStore(file);
    expect(store.list()).toEqual([]);
    expect(store.last()).toBeUndefined();
    store.append({ type: "AgentRegistered", id: "agent-1" });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("appends in order and chains prevSeq", () => {
    const store = new EventStore(file);
    const a = store.append({ type: "SpendReserved", spendId: "0xaa", amount: "250000" });
    const b = store.append({ type: "SpendCommitted", spendId: "0xaa", txId: "0.0.1@1.2" });

    expect(a).toMatchObject({ v: 1, seq: 1, prevSeq: 0, type: "SpendReserved", amount: "250000" });
    expect(b).toMatchObject({ v: 1, seq: 2, prevSeq: 1, type: "SpendCommitted" });
    expect(new Date(a.ts).toISOString()).toBe(a.ts);
    expect(store.list().map((e) => e.type)).toEqual(["SpendReserved", "SpendCommitted"]);
    expect(store.last()).toEqual(b);

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([a, b]);
  });

  it("keeps a caller-supplied ts", () => {
    const store = new EventStore(file);
    const e = store.append({ type: "Repaid", ts: "2026-11-06T00:00:00.000Z" });
    expect(e.ts).toBe("2026-11-06T00:00:00.000Z");
  });

  it("continues the chain after reopening the file", () => {
    const first = new EventStore(file);
    first.append({ type: "ReceivableUploaded", id: "rcv-1" });
    first.append({ type: "ReceivableConfirmed", id: "rcv-1" });

    const reopened = new EventStore(file);
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.last()).toMatchObject({ seq: 2, type: "ReceivableConfirmed" });

    const c = reopened.append({ type: "NftMinted", id: "rcv-1" });
    expect(c).toMatchObject({ seq: 3, prevSeq: 2 });
    expect(new EventStore(file).list().map((e) => [e.seq, e.prevSeq])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  it("filters events by id", () => {
    const store = new EventStore(file);
    store.append({ type: "ReceivableUploaded", id: "rcv-1" });
    store.append({ type: "ReceivableUploaded", id: "rcv-2" });
    store.append({ type: "ReceivableConfirmed", id: "rcv-1" });
    expect(store.byId("rcv-1").map((e) => e.type)).toEqual([
      "ReceivableUploaded",
      "ReceivableConfirmed",
    ]);
    expect(store.byId("missing")).toEqual([]);
  });
});
