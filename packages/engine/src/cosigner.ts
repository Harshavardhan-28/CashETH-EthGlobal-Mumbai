export type OpenReservation = {
  spendId: `0x${string}`;
  spendWalletId: string;
  merchantAccountId: string;
  amount: bigint;
  expiry: bigint;
};

export type PaymentRequirementsLike = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  extra?: Record<string, unknown>;
};

export type ApprovePaymentInput = {
  requirements: PaymentRequirementsLike;
  reservation: OpenReservation;
  usdcTokenId: string;
  network: string;
  now: bigint;
  payerAccountId?: string;
};

export type ApprovePaymentResult = { ok: true } | { ok: false; reason: string };

function parseAmount(amount: string): bigint | undefined {
  if (!/^\d+$/.test(amount)) return undefined;
  return BigInt(amount);
}

/** Co-signer policy: only sign a payment that matches an open on-chain reservation. */
export function approvePayment(input: ApprovePaymentInput): ApprovePaymentResult {
  const { requirements, reservation, now } = input;

  if (requirements.scheme !== "exact") return { ok: false, reason: "wrong_scheme" };
  if (requirements.network !== input.network) return { ok: false, reason: "wrong_network" };
  if (requirements.asset !== input.usdcTokenId) return { ok: false, reason: "wrong_asset" };
  if (requirements.payTo !== reservation.merchantAccountId) {
    return { ok: false, reason: "wrong_payee" };
  }

  const amount = parseAmount(requirements.amount);
  if (amount === undefined) return { ok: false, reason: "invalid_amount" };
  if (amount > reservation.amount) return { ok: false, reason: "amount_exceeds_reservation" };

  if (now >= reservation.expiry) return { ok: false, reason: "reservation_expired" };

  if (input.payerAccountId !== undefined && input.payerAccountId !== reservation.spendWalletId) {
    return { ok: false, reason: "wrong_payer" };
  }

  return { ok: true };
}
