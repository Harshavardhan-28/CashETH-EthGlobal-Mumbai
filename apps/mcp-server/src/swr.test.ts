import { describe, expect, it } from "vitest";
import { staleWhileRevalidate } from "./orchestrator/swr.js";

/** A loader whose calls are counted and whose next result the test controls. */
function counter(values: (number | Error)[]) {
  let calls = 0;
  const load = async () => {
    const v = values[Math.min(calls++, values.length - 1)];
    if (v instanceof Error) throw v;
    return v;
  };
  return { load, calls: () => calls };
}

describe("staleWhileRevalidate", () => {
  it("loads a missing key once, even for concurrent callers", async () => {
    const cache = staleWhileRevalidate<number>(1_000, () => 0);
    const c = counter([7]);
    await expect(Promise.all([cache.get("k", c.load), cache.get("k", c.load)])).resolves.toEqual([7, 7]);
    expect(c.calls()).toBe(1);
  });

  it("answers a fresh key from the cache without loading", async () => {
    const cache = staleWhileRevalidate<number>(1_000, () => 0);
    const c = counter([1, 2]);
    await cache.get("k", c.load);
    await expect(cache.get("k", c.load)).resolves.toBe(1);
    expect(c.calls()).toBe(1);
  });

  it("answers a stale key at once with the old value and refreshes it in the background", async () => {
    let now = 0;
    const cache = staleWhileRevalidate<number>(1_000, () => now);
    const c = counter([1, 2]);
    await cache.get("k", c.load);
    now = 5_000;
    await expect(cache.get("k", c.load)).resolves.toBe(1);
    await cache.settled();
    await expect(cache.get("k", c.load)).resolves.toBe(2);
    expect(c.calls()).toBe(2);
  });

  it("keeps the last good value when a background refresh fails", async () => {
    let now = 0;
    const cache = staleWhileRevalidate<number>(1_000, () => now);
    const c = counter([1, new Error("relay 502")]);
    await cache.get("k", c.load);
    now = 5_000;
    await cache.get("k", c.load);
    await cache.settled();
    await expect(cache.get("k", c.load)).resolves.toBe(1);
  });

  it("does not cache a failed first load", async () => {
    const cache = staleWhileRevalidate<number>(1_000, () => 0);
    const c = counter([new Error("relay 502"), 3]);
    await expect(cache.get("k", c.load)).rejects.toThrow("relay 502");
    await expect(cache.get("k", c.load)).resolves.toBe(3);
  });

  it("keeps keys apart", async () => {
    const cache = staleWhileRevalidate<string>(1_000, () => 0);
    await cache.get("a", async () => "A");
    await expect(cache.get("b", async () => "B")).resolves.toBe("B");
    await expect(cache.get("a", async () => "x")).resolves.toBe("A");
  });
});
