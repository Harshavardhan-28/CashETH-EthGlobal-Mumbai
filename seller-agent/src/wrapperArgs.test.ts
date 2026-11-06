import { describe, expect, it } from "vitest";
import { emptyFacts } from "./facts.js";
import { wrapperArgs, type WrapperContext } from "./wrapperArgs.js";

const context: WrapperContext = { runId: "run-1", step: 2, index: 0, facts: emptyFacts(), pinned: {} };
const PAYEE_EVM = "0x0000000000000000000000000000000000aceeb8"; // 0.0.11333304, hand-computed: 11333304 = 0xaceeb8

describe("wrapperArgs", () => {
  it("turns a merchant given as a Hedera account id into its long-zero EVM address on reserve_spend", () => {
    const args = wrapperArgs("reserve_spend", { id: "0x1", merchant: "0.0.11333304", amount: "500000" }, context);
    expect(args.merchant).toBe(PAYEE_EVM);
  });

  it("does the same for every merchant of every budget on set_budgets, leaving EVM addresses alone", () => {
    const budgets = [{ worker: "0xd1", alloc: "500000", maxPerTx: "500000", maxDaily: "500000", merchants: ["0.0.11333304", PAYEE_EVM] }];
    const args = wrapperArgs("set_budgets", { id: "0x1", budgets }, context);
    expect((args.budgets as { merchants: string[] }[])[0]!.merchants).toEqual([PAYEE_EVM, PAYEE_EVM]);
  });
});
