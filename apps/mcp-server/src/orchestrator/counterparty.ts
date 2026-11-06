/**
 * The seller as the main agent (demo): the seller's own tools drive its counterparties, which the server runs with
 * their own in-process keys. Every on-chain act is still signed by the party it belongs to: the buyer's EIP-712
 * confirmation and repayment by the buyer's key, the purchase by the seller's worker through its 2-of-2 spend
 * wallet and the co-signer. Each step goes through the same orchestrator function a direct call would, as a caller
 * whose role, level and scopes come from that party's on-chain KYA record.
 */
import { ROLES, scopesForRole } from "@casheth/shared";
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { addr, bytes32, requireParty, units } from "./common.js";
import { fail, ToolError } from "./errors.js";
import { confirmReceivable, typedDataOf } from "./receivables.js";
import { repayReceivable } from "./repay.js";
import { commitSpend, payX402, reserveSpend, spendIdOf } from "./spend.js";
import type { Caller, Orchestrator } from "./types.js";

const HEDERA_ACCOUNT = /^0\.0\.(\d+)$/;

/** `0.0.N` -> the long-zero EVM address; an EVM address is checked and returned. */
function merchantAddress(value: string): Address {
  const m = HEDERA_ACCOUNT.exec(value.trim());
  if (!m) return addr(value, "merchant");
  return addr(`0x${BigInt(m[1]!).toString(16).padStart(40, "0")}`, "merchant");
}

/** A caller acting as `agent`, on behalf of the seller who asked: role, level and scopes from its KYA record. */
async function counterparty(o: Orchestrator, agent: Address, role: number, onBehalfOf: Caller): Promise<Caller> {
  if (!o.chain.holdsKey(agent)) fail("KEY_NOT_HELD", `the server does not hold the key for ${agent} (start it with AGENT_KEYS_IN_PROCESS=true for the demo)`);
  const kya = await o.chain.kyaAgent(agent);
  return {
    agent,
    role,
    level: kya.level,
    ownerGroup: kya.ownerGroup,
    scopes: scopesForRole(role, kya.level),
    sub: `counterparty:${onBehalfOf.agent}`,
    jti: `${onBehalfOf.jti}:${randomUUID()}`,
  };
}

/** `request_buyer_confirmation`: the buyer signs the pending receivable's confirmation and it is registered. */
export async function requestBuyerConfirmation(o: Orchestrator, caller: Caller, input: { pendingId: string }) {
  const pending = o.pending.get(input.pendingId);
  if (!pending) fail("NOT_FOUND", `no pending receivable ${input.pendingId}`);
  requireParty(caller, pending.seller, "seller");
  const buyer = await counterparty(o, pending.buyer, ROLES.Buyer, caller);
  const signature = await o.chain.signTypedData(pending.buyer, typedDataOf(pending));
  return confirmReceivable(o, buyer, { pendingId: input.pendingId, signature });
}

/** `buy_with_credit`: the seller's worker reserves, pays the x402 merchant (co-signed) and commits. */
export async function buyWithCredit(
  o: Orchestrator,
  caller: Caller,
  input: { id: string; url: string; merchant: string; amount: string; ttlSeconds?: number; idempotencyKey: string },
) {
  const id = bytes32(input.id, "id");
  const info = await o.chain.facilityInfo(id);
  requireParty(caller, info.seller, "seller");
  const setup = o.config.sellerWorker;
  if (!setup) fail("KEY_NOT_HELD", "no seller worker is configured (SELLER_WORKER_EVM / SELLER_SPEND_WALLET_EVM)");
  const worker = await counterparty(o, setup.worker, ROLES.Worker, caller);
  const merchant = merchantAddress(input.merchant);
  units(input.amount, "amount");

  const reserveKey = `${input.idempotencyKey}:reserve`;
  const spendId = await reserveOnce(o, worker, { id, worker: setup.worker, spendWallet: setup.spendWallet, merchant, amount: input.amount, ttlSeconds: input.ttlSeconds ?? 600, idempotencyKey: reserveKey });
  const paid = await payX402(o, worker, { spendId, url: input.url });
  const committed = await commitSpend(o, worker, { spendId, hederaTxId: paid.transactionId });
  return { status: "committed" as const, worker: setup.worker, spendId, transactionId: paid.transactionId, payment: paid, commit: committed };
}

/** Reserves, or recovers the reservation an earlier attempt with the same key already opened. */
async function reserveOnce(o: Orchestrator, worker: Caller, input: Parameters<typeof reserveSpend>[2]): Promise<Hex> {
  try {
    const reserved = await reserveSpend(o, worker, input);
    return reserved.spendId as Hex;
  } catch (error) {
    if (error instanceof ToolError && error.code === "RESERVATION_EXISTS") return spendIdOf(input.id as Hex, input.worker as Address, worker.agent, input.idempotencyKey);
    throw error;
  }
}

/** `settle_receivable`: the buyer pays the full invoice into the RepaymentRouter (lenders first, the seller the rest). */
export async function settleReceivable(o: Orchestrator, caller: Caller, input: { id: string }) {
  const id = bytes32(input.id, "id");
  const r = await o.chain.receivable(id);
  requireParty(caller, r.seller, "seller");
  const buyer = await counterparty(o, r.buyer, ROLES.Buyer, caller);
  return repayReceivable(o, buyer, { id, amount: r.amount.toString() });
}
