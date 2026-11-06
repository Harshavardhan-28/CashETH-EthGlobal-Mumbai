/**
 * Two-phase worker spending (BUILD.md section 9.2): reserve (engine check, then the coordinator's
 * `CreditFacility.reserve` funds the spend wallet), pay (x402 with the 2-of-2 spend wallet: the worker signs and
 * the policy co-signer adds its signature only for a payment that matches the open reservation), commit
 * (`CreditFacility.commit` with the Hedera transaction id hash).
 */
import { approvePayment, checkSpend } from "@casheth/engine";
import { CreditFacilityAbi, hashscan } from "@casheth/shared";
import { encodeFunctionData, encodePacked, keccak256, toHex, type Address, type Hex } from "viem";
import { record } from "./audit.js";
import {
  actor,
  addr,
  bytes32,
  FACILITY_ACTIVE,
  RELEASE_GRACE_SECONDS,
  requireParty,
  RESERVATION_OPEN,
  ROLE_NUMBERS,
  txLink,
  units,
  ZERO_HASH,
} from "./common.js";
import { fail, ToolError, type ToolErrorCode } from "./errors.js";
import { spendWalletProblem } from "./spendWallets.js";
import type { Caller, Orchestrator, PaymentRequirements, TransferSummary } from "./types.js";

export const DEFAULT_TTL_SECONDS = 600;
export const MAX_TTL_SECONDS = 3_600;

export type ReserveInput = {
  id: string;
  worker: string;
  spendWallet: string;
  merchant: string;
  amount: string;
  ttlSeconds?: number;
  idempotencyKey: string;
};

/** `spendId = keccak256(id ‖ worker ‖ nonce)`, the nonce derived from the caller's idempotency key. */
export function spendIdOf(id: Hex, worker: Address, caller: Address, idempotencyKey: string): Hex {
  const nonce = BigInt(keccak256(toHex(`${caller.toLowerCase()}:${idempotencyKey}`)));
  return keccak256(encodePacked(["bytes32", "address", "uint256"], [id, worker, nonce]));
}

/**
 * `reserve_spend`: the spend wallet must be a registered 2-of-2 wallet of the worker and the co-signer, then the
 * engine pre-flight (`checkSpend`), one open reservation per wallet, then `facility.reserve`.
 */
export async function reserveSpend(o: Orchestrator, caller: Caller, input: ReserveInput) {
  const id = bytes32(input.id, "id");
  const worker = addr(input.worker, "worker");
  const spendWallet = addr(input.spendWallet, "spendWallet");
  const merchant = addr(input.merchant, "merchant");
  const amount = units(input.amount, "amount");
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > MAX_TTL_SECONDS) fail("BAD_INPUT", `ttlSeconds must be 30..${MAX_TTL_SECONDS}`);

  const info = await o.chain.facilityInfo(id);
  if (caller.role === ROLE_NUMBERS.worker) requireParty(caller, worker, "worker");
  else requireParty(caller, info.seller, "seller of this facility");

  const rejected = async (code: ToolErrorCode, stage: "engine" | "contract", message: string, details: Record<string, unknown> = {}): Promise<never> => {
    await record(o, { type: "SpendRejected", id, worker, merchant, amount: amount.toString(), code, stage, ...details, ...actor(caller) });
    throw new ToolError(code, message, { stage, ...details });
  };

  const walletProblem = await spendWalletProblem(o.spendWallets, spendWallet, worker);
  if (walletProblem) {
    return rejected("SPEND_WALLET_NOT_REGISTERED", "engine", `spend wallet ${spendWallet} is not a registered 2-of-2 wallet of the worker and the co-signer`, {
      reason: walletProblem,
    });
  }

  const [budget, available, merchants, paused, now, busy] = await Promise.all([
    o.chain.budget(id, worker),
    o.chain.available(id),
    o.chain.merchants(id, worker),
    o.chain.paused(),
    o.chain.latestTimestamp(),
    o.chain.openReservationOf(spendWallet),
  ]);
  const verdict = checkSpend({
    amount,
    budget,
    available,
    mandate: { maxPerTx: budget.maxPerTx, maxDaily: budget.maxDaily, merchants },
    merchant,
    now,
    facilityActive: info.status === FACILITY_ACTIVE && now < info.dueDate,
    paused,
  });
  if (!verdict.ok) return rejected(verdict.code, "engine", `the spend policy rejected ${amount} units: ${verdict.code}`);
  if (busy !== ZERO_HASH) return rejected("WALLET_BUSY", "engine", `spend wallet ${spendWallet} already has open reservation ${busy}`);

  const spendId = spendIdOf(id, worker, caller.agent, input.idempotencyKey);
  const expiry = now + BigInt(ttl);
  let txHash: Hex;
  try {
    ({ txHash } = await o.chain.send("coordinator", {
      to: o.chain.addresses().creditFacility,
      data: encodeFunctionData({
        abi: CreditFacilityAbi,
        functionName: "reserve",
        args: [id, spendId, worker, spendWallet, merchant, amount, expiry],
      }),
      description: "CreditFacility.reserve(id, spendId, worker, spendWallet, merchant, amount, expiry)",
    }));
  } catch (err) {
    if (err instanceof ToolError) return rejected(err.code, "contract", err.message);
    throw err;
  }
  await record(o, {
    type: "SpendReserved",
    id,
    spendId,
    worker,
    spendWallet,
    merchant,
    amount: amount.toString(),
    asset: o.config.usdcTokenId,
    expiry: expiry.toString(),
    txHash,
    hashscan: txLink(txHash),
    ...actor(caller),
  });
  return { id, spendId, amount: amount.toString(), expiry: Number(expiry), txHash, hashscan: txLink(txHash) };
}

/**
 * The co-signer's second check, on the transaction bytes themselves: the only token movement is exactly `amount`
 * of USDC from the spend wallet to `payTo`, and the spend wallet pays no HBAR. Returns a refusal reason or
 * `undefined`.
 */
export function checkTransfer(
  t: TransferSummary,
  p: { usdcTokenId: string; spendWalletId: string; payTo: string; amount: bigint },
): string | undefined {
  if (t.tokenTransfers.some((x) => x.tokenId !== p.usdcTokenId)) return "foreign_token_transfer";
  const debits = t.tokenTransfers.filter((x) => x.amount < 0n);
  const credits = t.tokenTransfers.filter((x) => x.amount > 0n);
  if (debits.length !== 1 || credits.length !== 1) return "unexpected_transfer_shape";
  if (debits[0]!.accountId !== p.spendWalletId) return "wrong_payer";
  if (credits[0]!.accountId !== p.payTo) return "wrong_payee";
  if (credits[0]!.amount !== p.amount || debits[0]!.amount !== -p.amount) return "amount_mismatch";
  if (t.hbarTransfers.some((x) => x.accountId === p.spendWalletId && x.amount < 0n)) return "hbar_debit";
  return undefined;
}

/**
 * `pay_x402`: pays `url` from the reservation's spend wallet. The URL's origin must be configured for the
 * reservation's merchant (no fetches anywhere else). The worker key signs (held in process for the demo);
 * `cosign` runs the engine's `approvePayment` against the open reservation and the byte-level `checkTransfer`,
 * and signs with the co-signer key only when both pass.
 */
export async function payX402(o: Orchestrator, caller: Caller, input: { spendId: string; url: string }) {
  const spendId = bytes32(input.spendId, "spendId");
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    fail("BAD_INPUT", "url is not a URL");
  }
  const r = await o.chain.reservation(spendId);
  if (r.status !== RESERVATION_OPEN) fail("RESERVATION_NOT_OPEN", `reservation ${spendId} is not open`);
  requireParty(caller, r.worker, "worker of this reservation");
  if (o.now() >= r.expiry) {
    // The co-signer's `approvePayment` would refuse too (`reservation_expired`); answering here keeps the fetch
    // from happening at all, but the refusal is still part of the audit trail.
    await record(o, { type: "SpendRejected", id: r.id, spendId, code: "RESERVATION_EXPIRED", reason: "reservation_expired", stage: "cosigner", ...actor(caller) });
    throw new ToolError("RESERVATION_EXPIRED", "the reservation expired; reserve again", { spendId });
  }

  const [spendWalletId, merchantAccountId] = await Promise.all([o.x402.accountIdOf(r.spendWallet), o.x402.accountIdOf(r.merchant)]);
  if (!(o.config.merchantOrigins[merchantAccountId] ?? []).includes(url.origin)) {
    fail("MERCHANT_URL_NOT_ALLOWED", `${url.origin} is not a configured origin of the reservation's merchant ${merchantAccountId}`, { origin: url.origin });
  }
  let refusal: string | undefined;
  const cosign = async (txBase64: string, requirements: PaymentRequirements): Promise<string> => {
    const transfer = o.x402.decodeTransfer(txBase64);
    const payer = transfer.tokenTransfers.find((x) => x.amount < 0n)?.accountId;
    const verdict = approvePayment({
      requirements,
      reservation: { spendId, spendWalletId, merchantAccountId, amount: r.amount, expiry: r.expiry },
      usdcTokenId: o.config.usdcTokenId,
      network: o.config.x402Network,
      now: o.now(),
      ...(payer ? { payerAccountId: payer } : {}),
    });
    refusal = verdict.ok
      ? checkTransfer(transfer, { usdcTokenId: o.config.usdcTokenId, spendWalletId, payTo: requirements.payTo, amount: BigInt(requirements.amount) })
      : verdict.reason;
    if (refusal) throw new ToolError("COSIGNER_REFUSED", `co-signer refused: ${refusal}`, { reason: refusal });
    return o.x402.cosignerSign(txBase64);
  };

  let result;
  try {
    result = await o.x402.pay({ worker: r.worker, spendWalletId, url: url.href, cosign });
  } catch (err) {
    if (refusal) {
      await record(o, { type: "SpendRejected", id: r.id, spendId, code: "COSIGNER_REFUSED", reason: refusal, stage: "cosigner", ...actor(caller) });
      throw new ToolError("COSIGNER_REFUSED", `co-signer refused: ${refusal}`, { reason: refusal, spendId });
    }
    throw err;
  }
  if (!result.transactionId) fail("PAYMENT_FAILED", `the merchant answered ${result.status} without a settlement`, { status: result.status, body: result.body });
  return {
    spendId,
    transactionId: result.transactionId,
    hashscan: hashscan.tx(result.transactionId),
    status: result.status,
    body: result.body,
  };
}

/**
 * `commit_spend`: records the payment's Hedera transaction id on the reservation. Allowed until `expiry +
 * RELEASE_GRACE` (1 h), after which anyone may release the reservation; the engine commits well inside it.
 */
export async function commitSpend(o: Orchestrator, caller: Caller, input: { spendId: string; hederaTxId: string }) {
  const spendId = bytes32(input.spendId, "spendId");
  if (!/^\d+\.\d+\.\d+@\d+\.\d+$/.test(input.hederaTxId)) fail("BAD_INPUT", "hederaTxId must look like 0.0.x@seconds.nanos");
  const r = await o.chain.reservation(spendId);
  if (r.status !== RESERVATION_OPEN) fail("RESERVATION_NOT_OPEN", `reservation ${spendId} is not open`);
  requireParty(caller, r.worker, "worker of this reservation");
  if (o.now() > r.expiry + RELEASE_GRACE_SECONDS) fail("RESERVATION_EXPIRED", "past expiry + 1 h: the reservation can only be released");
  const txIdHash = keccak256(toHex(input.hederaTxId));
  const { txHash } = await o.chain.send("coordinator", {
    to: o.chain.addresses().creditFacility,
    data: encodeFunctionData({ abi: CreditFacilityAbi, functionName: "commit", args: [spendId, txIdHash] }),
    description: "CreditFacility.commit(spendId, txIdHash)",
  });
  const merchantAccountId = await o.x402.accountIdOf(r.merchant).catch(() => undefined);
  await record(o, {
    type: "SpendCommitted",
    id: r.id,
    spendId,
    worker: r.worker,
    amount: r.amount.toString(),
    asset: o.config.usdcTokenId,
    merchant: merchantAccountId ?? r.merchant,
    txId: input.hederaTxId,
    txIdHash,
    paymentHashscan: hashscan.tx(input.hederaTxId),
    txHash,
    hashscan: txLink(txHash),
    ...actor(caller),
  });
  return { spendId, txIdHash, txHash, hashscan: txLink(txHash), payment: hashscan.tx(input.hederaTxId) };
}
