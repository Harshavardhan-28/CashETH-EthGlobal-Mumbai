import { describe, expect, it } from "vitest";
import { EVENTS_FIXTURE, RECEIVABLE_FIXTURE } from "./fixtures";
import { formatUnits, latestReceivableId, liveStats, shorten, toConsoleEvent, toConsoleEvents } from "./liveConsole";

describe("formatUnits", () => {
  it.each([
    ["0", "$0.00"],
    ["250000", "$0.25"],
    ["10000000000", "$10,000.00"],
    ["6036990000", "$6,036.99"],
  ])("%s units is %s", (units, expected) => {
    expect(formatUnits(units)).toBe(expected);
  });
});

describe("toConsoleEvent", () => {
  it("numbers, attributes and describes an audit event", () => {
    const ev = toConsoleEvent(EVENTS_FIXTURE[0]);
    expect(ev).toMatchObject({ seq: "001", role: "SELLER", type: "ReceivableUploaded", step: 1 });
    expect(ev.detail).toBe("0x7f3a…c21e · $10,000.00");
    expect(ev.err).toBeUndefined();
  });

  it("flags rejections and surfaces a failed HCS publish", () => {
    const ev = toConsoleEvent(EVENTS_FIXTURE[4]);
    expect(ev.err).toBe(true);
    expect(ev.detail).toContain("AGENT_BUDGET_EXCEEDED");
    expect(ev.detail).toContain("HCS publish failed");
  });
});

describe("toConsoleEvents", () => {
  it("keeps only the newest events, oldest first", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...EVENTS_FIXTURE[0], seq: i + 1 }));
    const shown = toConsoleEvents(many);
    expect(shown).toHaveLength(10);
    expect(shown[0].seq).toBe("016");
    expect(shown[9].seq).toBe("025");
  });
});

describe("live receivable", () => {
  it("follows the receivable on the newest event that names one", () => {
    expect(latestReceivableId(EVENTS_FIXTURE)).toBe(RECEIVABLE_FIXTURE.id);
    expect(latestReceivableId([])).toBeUndefined();
  });

  it("derives state, funded and lenders owed from its details", () => {
    expect(liveStats(RECEIVABLE_FIXTURE)).toEqual({ state: "Financed", base: "—", funded: "$6,000.00", owed: "$6,036.99" });
    expect(liveStats()).toEqual({ state: "—", base: "—", funded: "$0.00", owed: "$0.00" });
  });

  it("shortens long ids only", () => {
    expect(shorten("0x7f3a9c5d1e2b4a6098")).toBe("0x7f3a…6098");
    expect(shorten("short")).toBe("short");
  });
});
