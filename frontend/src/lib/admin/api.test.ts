import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createApiClient", () => {
  it("GETs /events and returns the JSON", async () => {
    const events = [{ v: 1, type: "SpendCommitted", seq: 1, prevSeq: 0, ts: "2026-11-07T12:00:00Z" }];
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(json(events));
    const out = await createApiClient("http://x", fetchImpl as unknown as typeof fetch).events();
    expect(out).toEqual(events);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/events");
  });

  it("hits the other endpoints", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>().mockImplementation(async () => json([]));
    const client = createApiClient("http://x/", fetchImpl as unknown as typeof fetch);
    await client.health();
    await client.agents();
    await client.lenders();
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["http://x/health", "http://x/agents", "http://x/lenders"]);
  });

  it("rejects with ApiError carrying the status", async () => {
    const fetchImpl = vi.fn(async () => json({ code: "NOT_DEPLOYED", message: "nope" }, 503));
    const err = await createApiClient("http://x", fetchImpl as unknown as typeof fetch)
      .events()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).message).toBe("nope");
  });

  it("still throws ApiError when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500, statusText: "Server Error" }));
    const err = await createApiClient("http://x", fetchImpl as unknown as typeof fetch)
      .agents()
      .catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(500);
  });

  it("propagates network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createApiClient("http://x", fetchImpl as unknown as typeof fetch).events()).rejects.toThrow("fetch failed");
  });
});
