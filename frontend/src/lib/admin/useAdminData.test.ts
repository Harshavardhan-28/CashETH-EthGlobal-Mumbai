import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, AuditEvent } from "./api";
import { groupRuns } from "./derive";
import { narrateAll } from "./narrate";
import { SAMPLE_AGENTS, SAMPLE_LENDERS, sampleEvents } from "./sample";
import { useAdminData } from "./useAdminData";

const EVENT: AuditEvent = { v: 1, type: "ReceivableUploaded", seq: 1, prevSeq: 0, ts: "2026-11-07T10:00:00.000Z", id: "0x01", amount: "1000000" };

function fakeClient() {
  let fail = false;
  const calls = { count: 0 };
  const guard = <T,>(value: T) => () => {
    calls.count += 1;
    return fail ? Promise.reject(new Error("down")) : Promise.resolve(value);
  };
  const client: ApiClient = {
    health: guard({ ok: true as const, resource: "r", authorizationServer: "a", events: 1 }),
    events: guard([EVENT]),
    agents: guard([]),
    lenders: guard([]),
  };
  return { client, calls, setFail: (v: boolean) => (fail = v) };
}

/** Lets the pending poll's promises settle inside act(). */
const flush = () => act(async () => {});

describe("useAdminData", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts loading, then goes live with the server's data", async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useAdminData({ client }));
    expect(result.current.status).toBe("loading");
    await flush();
    expect(result.current).toMatchObject({ status: "live", sample: false, events: [EVENT] });
    expect(result.current.updatedAt).toBeTypeOf("number");
  });

  it("shows labelled sample data when the server never answered", async () => {
    const { client, setFail } = fakeClient();
    setFail(true);
    const { result } = renderHook(() => useAdminData({ client }));
    await flush();
    expect(result.current.status).toBe("offline");
    expect(result.current.sample).toBe(true);
    expect(result.current.events.length).toBeGreaterThan(0);
    expect(result.current.agents).toBe(SAMPLE_AGENTS);
  });

  it("keeps the last good data when the server goes away mid-demo", async () => {
    const { client, setFail } = fakeClient();
    const { result } = renderHook(() => useAdminData({ client }));
    await flush();
    setFail(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toMatchObject({ status: "offline", sample: false, events: [EVENT] });
  });

  it("recovers to live data once the server is back", async () => {
    const { client, setFail } = fakeClient();
    setFail(true);
    const { result } = renderHook(() => useAdminData({ client }));
    await flush();
    expect(result.current.sample).toBe(true);
    setFail(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toMatchObject({ status: "live", sample: false, events: [EVENT] });
  });

  it("stops polling on unmount", async () => {
    const { client, calls } = fakeClient();
    const { unmount } = renderHook(() => useAdminData({ client }));
    await flush();
    unmount();
    const before = calls.count;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls.count).toBe(before);
  });
});

describe("sample story", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const items = narrateAll(sampleEvents(now), SAMPLE_AGENTS, "0.0.1");

  it("narrates with no undefined or NaN anywhere", () => {
    for (const n of items) {
      expect(`${n.actor.name} ${n.sentence} ${n.detail}`).not.toMatch(/undefined|NaN/);
    }
  });

  it("forms three invoice runs labelled by PO reference, the newest in progress", () => {
    const runs = groupRuns(items).filter((r) => r.id !== "setup");
    expect(runs.map((r) => r.title)).toEqual(["Invoice PO-1003", "Invoice PO-1002", "Invoice PO-1001"]);
    expect(runs.map((r) => r.status)).toEqual(["in_progress", "repaid", "repaid"]);
  });

  it("credits funding to the lenders and blocks one over-budget spend", () => {
    const funded = items.filter((n) => n.type === "FacilityFunded").map((n) => n.actor.name);
    expect(funded).toContain("Lender A & Lender B");
    const blocked = items.filter((n) => n.tone === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].sentence).toContain("blocked");
  });

  it("has lenders matching the lender agents", () => {
    expect(SAMPLE_LENDERS.map((l) => l.address)).toEqual(SAMPLE_AGENTS.filter((a) => a.role === "lender").map((a) => a.address));
  });
});
