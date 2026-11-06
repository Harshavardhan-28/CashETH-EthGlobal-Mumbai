import { describe, expect, it } from "vitest";
import { CONSOLE_EVENTS } from "./content";
import { consoleStats, facilityState } from "./consoleState";

describe("facilityState", () => {
  it.each([
    [0, "—"],
    [1, "Pending"],
    [3, "Pending"],
    [4, "Confirmed"],
    [6, "Confirmed"],
    [7, "Financed"],
    [9, "Financed"],
    [10, "Repaid"],
  ])("after %i events the state is %s", (shown, expected) => {
    expect(facilityState(shown)).toBe(expected);
  });
});

describe("consoleStats", () => {
  it("shows nothing funded before the borrowing base is computed", () => {
    expect(consoleStats(2)).toEqual({ base: "—", funded: "$0.00", owed: "$0.00" });
  });

  it("shows the borrowing base once the receivable is verified", () => {
    expect(consoleStats(3).base).toBe("$7,500.00");
  });

  it("shows funding and lenders owed after the spend step", () => {
    expect(consoleStats(7)).toEqual({ base: "$7,500.00", funded: "$6,000.00", owed: "$6,036.99" });
  });

  it("clears lenders owed once the buyer has repaid", () => {
    expect(consoleStats(10).owed).toBe("$0.00");
  });
});

describe("CONSOLE_EVENTS", () => {
  it("only moves forward through the eight lifecycle steps", () => {
    const steps = CONSOLE_EVENTS.map((e) => e.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(Math.min(...steps)).toBe(1);
    expect(Math.max(...steps)).toBe(8);
  });
});
