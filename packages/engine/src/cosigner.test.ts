import { describe, expect, it } from "vitest";
import { approvePayment, type OpenReservation, type PaymentRequirementsLike } from "./cosigner.js";

const USDC = "0.0.429274";
const NETWORK = "hedera:testnet";
const NOW = 1_700_000_000n;

const demoRequirements: PaymentRequirementsLike = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.429274",
  payTo: "0.0.11333304",
  amount: "250000",
};

const reservation: OpenReservation = {
  spendId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  spendWalletId: "0.0.5005",
  merchantAccountId: "0.0.11333304",
  amount: 250_000n,
  expiry: NOW + 300n,
};

function approve(
  req: Partial<PaymentRequirementsLike> = {},
  opts: { now?: bigint; payerAccountId?: string } = {},
) {
  return approvePayment({
    requirements: { ...demoRequirements, ...req },
    reservation,
    usdcTokenId: USDC,
    network: NETWORK,
    now: opts.now ?? NOW,
    ...(opts.payerAccountId !== undefined ? { payerAccountId: opts.payerAccountId } : {}),
  });
}

describe("approvePayment", () => {
  it("approves the exact demo requirements against a matching reservation", () => {
    expect(approve()).toEqual({ ok: true });
  });

  it("approves when the payer is the reservation's spend wallet", () => {
    expect(approve({}, { payerAccountId: "0.0.5005" })).toEqual({ ok: true });
  });

  it("approves an amount below the reservation", () => {
    expect(approve({ amount: "100000" })).toEqual({ ok: true });
  });

  it("refuses a scheme other than exact", () => {
    expect(approve({ scheme: "upto" })).toEqual({ ok: false, reason: "wrong_scheme" });
  });

  it("refuses a different network", () => {
    expect(approve({ network: "hedera:mainnet" })).toEqual({ ok: false, reason: "wrong_network" });
  });

  it("refuses a different asset", () => {
    expect(approve({ asset: "0.0.999999" })).toEqual({ ok: false, reason: "wrong_asset" });
  });

  it("refuses a payTo that is not the reserved merchant", () => {
    expect(approve({ payTo: "0.0.666" })).toEqual({ ok: false, reason: "wrong_payee" });
  });

  it("refuses an amount larger than the reservation", () => {
    expect(approve({ amount: "250001" })).toEqual({
      ok: false,
      reason: "amount_exceeds_reservation",
    });
  });

  it("refuses a non-integer amount instead of throwing", () => {
    expect(approve({ amount: "0.25" })).toEqual({ ok: false, reason: "invalid_amount" });
    expect(approve({ amount: "" })).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("refuses an expired reservation, including at the exact expiry second", () => {
    expect(approve({}, { now: NOW + 300n })).toEqual({ ok: false, reason: "reservation_expired" });
    expect(approve({}, { now: NOW + 301n })).toEqual({ ok: false, reason: "reservation_expired" });
  });

  it("refuses a payer other than the reservation's spend wallet", () => {
    expect(approve({}, { payerAccountId: "0.0.7777" })).toEqual({
      ok: false,
      reason: "wrong_payer",
    });
  });
});
