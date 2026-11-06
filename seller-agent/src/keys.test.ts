import { describe, expect, it } from "vitest";
import { stepKey } from "./keys.js";

describe("stepKey", () => {
  it("is the same for the same run, step and call", () => {
    expect(stepKey("run-1", 4, 0, "reserve_spend")).toBe(stepKey("run-1", 4, 0, "reserve_spend"));
  });

  it("differs per run, per step and per call within a step", () => {
    const keys = new Set([
      stepKey("run-1", 4, 0, "reserve_spend"),
      stepKey("run-2", 4, 0, "reserve_spend"),
      stepKey("run-1", 5, 0, "reserve_spend"),
      stepKey("run-1", 4, 1, "reserve_spend"),
    ]);
    expect(keys.size).toBe(4);
  });

  it("fits the server's 8 to 128 character idempotencyKey", () => {
    const key = stepKey("2026-11-07T01-00-00-000Z", 30, 3, "request_buyer_confirmation");
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});
