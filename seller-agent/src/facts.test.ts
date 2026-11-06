import { describe, expect, it } from "vitest";
import { applyResult, emptyFacts } from "./facts.js";

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe("applyResult", () => {
  it("counts budgets as set only when the server sent the transaction, not when it handed back calldata", () => {
    expect(applyResult(emptyFacts(), call("set_budgets"), { id: "0x1", mode: "sent", txHash: "0xb0" })).toEqual({ budgetsSet: true });
    expect(applyResult(emptyFacts(), call("set_budgets"), { id: "0x1", mode: "calldata", calls: [] })).toEqual({});
  });

  it("ignores an error result, whatever tool it came from", () => {
    expect(applyResult(emptyFacts(), call("open_facility"), { error: { code: "NO_ELIGIBLE_LIQUIDITY" } })).toEqual({});
  });
});
