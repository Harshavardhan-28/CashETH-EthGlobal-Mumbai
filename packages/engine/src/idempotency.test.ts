import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyLedger } from "./idempotency.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-idem-"));
  file = join(dir, "data", "idempotency.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type SpendResult = { spendId: string; amount: bigint; nested: { fees: bigint[] }; ok: boolean };

describe("IdempotencyLedger", () => {
  it("returns undefined and has() false for an unknown key", () => {
    const ledger = new IdempotencyLedger(file);
    expect(ledger.has("k")).toBe(false);
    expect(ledger.get("k")).toBeUndefined();
  });

  it("replays the stored result, bigint fields included, after reopening", () => {
    const result: SpendResult = {
      spendId: "0xabc",
      amount: 5_500_000n,
      nested: { fees: [1n, 2n ** 70n] },
      ok: true,
    };
    new IdempotencyLedger(file).put("spend:req-1", result);

    const reopened = new IdempotencyLedger(file);
    expect(reopened.has("spend:req-1")).toBe(true);
    const replay = reopened.get<SpendResult>("spend:req-1");
    expect(replay).toEqual(result);
    expect(typeof replay?.amount).toBe("bigint");
    expect(replay?.nested.fees[1]).toBe(2n ** 70n);
  });

  it("persists every put and keeps earlier keys", () => {
    const ledger = new IdempotencyLedger(file);
    ledger.put("a", { n: 1n });
    ledger.put("b", "plain");
    const reopened = new IdempotencyLedger(file);
    expect(reopened.get("a")).toEqual({ n: 1n });
    expect(reopened.get("b")).toBe("plain");
  });
});
