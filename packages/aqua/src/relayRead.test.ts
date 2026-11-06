import { ContractFunctionZeroDataError } from "viem";
import { describe, expect, it } from "vitest";
import { limitConcurrency, retryEmptyResult } from "./relayRead.js";

const empty = () => new ContractFunctionZeroDataError({ functionName: "decodeLenderOrder" });

describe("retryEmptyResult", () => {
  it("retries a read the relay answered with empty data, then returns the real answer", async () => {
    let calls = 0;
    const value = await retryEmptyResult(async () => {
      calls++;
      if (calls < 3) throw empty();
      return "decoded";
    }, { delayMs: 1 });
    expect(value).toBe("decoded");
    expect(calls).toBe(3);
  });

  it("gives up after the last attempt with the relay's error", async () => {
    let calls = 0;
    await expect(retryEmptyResult(async () => (calls++, Promise.reject(empty())), { attempts: 3, delayMs: 1 })).rejects.toBeInstanceOf(ContractFunctionZeroDataError);
    expect(calls).toBe(3);
  });

  it("does not retry other errors (a revert is an answer)", async () => {
    let calls = 0;
    await expect(retryEmptyResult(async () => (calls++, Promise.reject(new Error("reverted"))), { delayMs: 1 })).rejects.toThrow("reverted");
    expect(calls).toBe(1);
  });
});

describe("limitConcurrency", () => {
  it("runs at most `limit` tasks at once and keeps the input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await limitConcurrency([5, 4, 3, 2, 1], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n * 3));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 40, 30, 20, 10]);
    expect(peak).toBe(2);
  });
});
