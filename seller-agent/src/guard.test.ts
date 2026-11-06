import { describe, expect, it } from "vitest";
import { guardCall, type GuardContext } from "./guard.js";
import { emptyFacts } from "./facts.js";

const PAID = "https://paid.example";
const SPEND = "0x" + "5".repeat(64);

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return { facts: emptyFacts(), spendCap: 1_000_000n, paidApiOrigin: PAID, pendingSpend: 0n, ...overrides };
}

describe("guardCall", () => {
  it("refuses pay_x402 for a spendId this run never reserved", () => {
    const verdict = guardCall({ name: "pay_x402", args: { spendId: SPEND, url: `${PAID}/price-feed` } }, context());
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "UNKNOWN_SPEND" } });
  });

  it("refuses pay_x402 for a URL off the paid-API origin, even for a reserved spendId", () => {
    const facts = { ...emptyFacts(), spendIds: [SPEND] };
    const verdict = guardCall({ name: "pay_x402", args: { spendId: SPEND, url: "https://evil.example/price-feed" } }, context({ facts }));
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "URL_NOT_ALLOWED" } });
  });

  it("lets pay_x402 through for a reserved spendId on the paid-API origin", () => {
    const facts = { ...emptyFacts(), spendIds: [SPEND] };
    const verdict = guardCall({ name: "pay_x402", args: { spendId: SPEND, url: `${PAID}/price-feed?symbols=HBAR` } }, context({ facts }));
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses commit_spend for a spendId this run never reserved", () => {
    const verdict = guardCall({ name: "commit_spend", args: { spendId: SPEND, hederaTxId: "0.0.1@1.2" } }, context());
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "UNKNOWN_SPEND" } });
  });

  it("refuses a reservation above the run's spend cap", () => {
    const verdict = guardCall({ name: "reserve_spend", args: { amount: "1000001" } }, context());
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "SPEND_CAP_EXCEEDED" } });
  });

  it("counts what was already reserved and what this turn reserves against the cap", () => {
    const facts = { ...emptyFacts(), spent: "600000" };
    expect(guardCall({ name: "reserve_spend", args: { amount: "400000" } }, context({ facts }))).toEqual({ ok: true });
    expect(guardCall({ name: "reserve_spend", args: { amount: "400000" } }, context({ facts, pendingSpend: 1n }))).toMatchObject({ ok: false });
  });

  it("refuses a reservation whose amount is not a positive base-unit string", () => {
    expect(guardCall({ name: "reserve_spend", args: { amount: "0.5" } }, context())).toMatchObject({ ok: false, refusal: { code: "BAD_INPUT" } });
  });

  it("refuses to ask the buyer to confirm an upload this run did not make", () => {
    const verdict = guardCall({ name: "request_buyer_confirmation", args: { pendingId: SPEND } }, context());
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "UNKNOWN_RECEIVABLE" } });
  });

  it("refuses to ask the buyer to repay a receivable this run did not finance", () => {
    const facts = { ...emptyFacts(), receivableId: SPEND as `0x${string}` };
    const verdict = guardCall({ name: "request_buyer_repayment", args: { id: SPEND } }, context({ facts }));
    expect(verdict).toMatchObject({ ok: false, refusal: { code: "NOT_FINANCED_IN_RUN" } });
  });

  it("lets read-only tools through untouched", () => {
    expect(guardCall({ name: "get_receivable_status", args: { id: SPEND } }, context())).toEqual({ ok: true });
  });
});
