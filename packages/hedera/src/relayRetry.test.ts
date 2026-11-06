import { describe, expect, it } from "vitest";
import { isTransientRelayFailure, retryingFetch } from "./relayRetry.js";

describe("isTransientRelayFailure", () => {
  it("retries the relay's generic failures on 400, 429, 500, 502, 503 and 504", () => {
    expect(isTransientRelayFailure(400, '{"error":{"message":"RPC Request failed"}}')).toBe(true);
    expect(isTransientRelayFailure(500, "Failed to save transaction to pool")).toBe(true);
    expect(isTransientRelayFailure(503, "Error invoking RPC: timeout")).toBe(true);
    expect(isTransientRelayFailure(400, "Missing or invalid parameters.\nDouble check you have provided the correct parameters.")).toBe(true);
    expect(isTransientRelayFailure(500, "Mirror node upstream failure: statusCode=502, message=Request failed with status code 502")).toBe(true);
    expect(isTransientRelayFailure(429, "")).toBe(true);
    expect(isTransientRelayFailure(502, "")).toBe(true);
    expect(isTransientRelayFailure(504, "gateway timeout")).toBe(true);
  });

  it("does not retry a 400 or 500 that is a real answer", () => {
    expect(isTransientRelayFailure(400, '{"error":{"message":"execution reverted"}}')).toBe(false);
    expect(isTransientRelayFailure(500, "nonce too low")).toBe(false);
    expect(isTransientRelayFailure(404, "RPC Request failed")).toBe(false);
  });
});

describe("retryingFetch", () => {
  const noSleep = async () => {};

  function sequence(...responses: Response[]) {
    const calls: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls.push(calls.length);
      return responses[Math.min(calls.length - 1, responses.length - 1)]!.clone();
    };
    return { calls, fetchImpl };
  }

  it("retries a transient failure until it succeeds, backing off exponentially", async () => {
    const { calls, fetchImpl } = sequence(new Response("RPC Request failed", { status: 400 }), new Response("", { status: 502 }), Response.json({ result: "0x1" }));
    const delays: number[] = [];
    const response = await retryingFetch(fetchImpl, { sleep: async (ms) => void delays.push(ms) })("http://relay");
    expect(await response.json()).toEqual({ result: "0x1" });
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it("gives up after five tries and returns the last failure", async () => {
    const { calls, fetchImpl } = sequence(new Response("RPC Request failed", { status: 400 }));
    const response = await retryingFetch(fetchImpl, { sleep: noSleep })("http://relay");
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(5);
  });

  it("never retries a response that came back OK, so a returned transaction hash is not sent again", async () => {
    const { calls, fetchImpl } = sequence(Response.json({ result: "0xhash" }));
    await retryingFetch(fetchImpl, { sleep: noSleep })("http://relay", { method: "POST", body: "eth_sendRawTransaction" });
    expect(calls).toHaveLength(1);
  });

  it("returns a real error at once", async () => {
    const { calls, fetchImpl } = sequence(new Response("execution reverted", { status: 400 }));
    expect((await retryingFetch(fetchImpl, { sleep: noSleep })("http://relay")).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
