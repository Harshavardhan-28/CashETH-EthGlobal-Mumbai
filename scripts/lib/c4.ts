/**
 * Shared setup for the live C4 scripts (scripts/c4-ship-strategies.ts, scripts/c4-open-facility.ts): the
 * deployed addresses, lender wallets, once-only HCS events and on-chain revert proofs.
 */
import type { AquaAddresses, LenderWallet } from "@casheth/aqua";
import { evmClients, mirror, publishAudit, readAuditMessages, type AuditEvent } from "@casheth/hedera";
import { hashscan, loadAddresses, type Addresses, type DemoAccount } from "@casheth/shared";
import { decodeErrorResult, getAddress, type Abi, type Address, type Hex, type WalletClient } from "viem";
import { env, gasOf, mirrorGet, txRecord, type ContractResult } from "../spikes/lib.js";
import type { Rejection } from "../c4-state.js";

export const LENDER_NAMES = ["A", "B", "C", "D"] as const;
export type LenderName = (typeof LENDER_NAMES)[number];

/** Gas for a transaction that is meant to revert (estimation would surface the revert and block the send). */
const REVERT_GAS = 300_000n;

function need<T>(name: string, value: T | undefined): T {
  if (value === undefined) throw new Error(`${name} is not set; run the earlier checkpoints first`);
  return value;
}

export type Deployment = {
  addresses: Addresses;
  /** The contracts `@casheth/aqua` talks to. */
  aqua: Required<AquaAddresses>;
  creditFacility: Address;
  /** Block of the Aqua registry creation: where log discovery starts. */
  fromBlock: bigint;
};

export function loadDeployment(): Deployment {
  const addresses = loadAddresses();
  return {
    addresses,
    aqua: {
      aqua: need("addresses.aqua", addresses.aqua),
      swapRouter: need("addresses.swapRouter", addresses.swapRouter),
      orderBuilder: need("addresses.orderBuilder", addresses.orderBuilder),
      rcn: need("addresses.rcn", addresses.rcn),
      tUsdt: need("addresses.tUsdt", addresses.tUsdt),
      usdc: getAddress(env.USDC_EVM_ADDRESS),
    },
    creditFacility: need("addresses.creditFacility", addresses.creditFacility),
    fromBlock: BigInt(need("addresses.deployedBlock", addresses.deployedBlock)),
  };
}

/** The demo account `<PREFIX>_KEY` from `.env.accounts`. */
export function accountKey(prefix: DemoAccount): Hex {
  return need(`${prefix}_KEY`, env[`${prefix}_KEY`]) as Hex;
}

export function accountEvm(prefix: DemoAccount): Address {
  return getAddress(need(`${prefix}_EVM`, env[`${prefix}_EVM`]));
}

/** `evmClients` always binds an account and the chain when given a key. */
export function walletFor(prefix: DemoAccount): LenderWallet {
  return evmClients(env, accountKey(prefix)).wallet as LenderWallet;
}

async function latestSeq(topicId: string): Promise<number> {
  const [last] = await mirror.topicMessages(env, topicId, { limit: 1, order: "desc" });
  return last?.sequence_number ?? 0;
}

/**
 * Publishes an audit event of `type` for `id` unless one with the same fields is already on the topic (a crash
 * between publishing and saving must not publish twice). A receivable id can repeat across redeployments, so
 * the fields (transaction ids, serials) tell the earlier event from this one. Returns where it is.
 */
export async function publishAuditOnce(
  client: Parameters<typeof publishAudit>[0],
  topicId: string,
  type: AuditEvent["type"],
  id: string,
  fields: Record<string, unknown>,
): Promise<{ seq: number; txId: string; hashscan: string; prevSeq: number }> {
  const sameFields = (message: AuditEvent) =>
    Object.entries(fields).every(([k, v]) => JSON.stringify((message as Record<string, unknown>)[k]) === JSON.stringify(v));
  const prior = (await readAuditMessages(env, topicId, { limit: 100 })).find(
    (m) => m.message.type === type && m.message.id === id && sameFields(m.message),
  );
  if (prior) {
    const txId = prior.txId ?? prior.consensusTimestamp;
    console.log(`  ${type}: already on the topic at seq ${prior.sequenceNumber}`);
    return { seq: prior.sequenceNumber, txId, hashscan: hashscan.tx(txId), prevSeq: prior.message.prevSeq };
  }
  const prevSeq = await latestSeq(topicId);
  const event: AuditEvent = { v: 1, type, id, ...fields, prevSeq, ts: new Date().toISOString() };
  const { sequenceNumber, txId } = await publishAudit(client, topicId, event);
  console.log(`  ${type}: seq ${sequenceNumber} ${hashscan.tx(txId)}`);
  return { seq: sequenceNumber, txId, hashscan: hashscan.tx(txId), prevSeq };
}

/**
 * Sends a call that must revert, with an explicit gas limit so it reaches consensus, then proves the reason
 * on-chain: the mirror node's `error_message` is decoded with `abi` and must be the custom error `expected`.
 */
export async function proveRevert(
  from: WalletClient,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  expected: string,
  label: string,
): Promise<Rejection> {
  const { public: pub } = evmClients(env);
  const hash = await from.writeContract({
    ...request,
    gas: REVERT_GAS,
    account: from.account!,
    chain: from.chain,
  } as Parameters<WalletClient["writeContract"]>[0]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "reverted") throw new Error(`${label}: expected a revert, got ${receipt.status} (${hash})`);

  const result = await mirror.waitFor(() => mirrorGet<ContractResult>(`/contracts/results/${hash}`), {
    attempts: 15,
    delayMs: 2000,
  });
  const errorMessage = result.error_message;
  if (!errorMessage?.startsWith("0x")) throw new Error(`${label}: mirror has no revert data (${String(errorMessage)})`);
  const { errorName, args } = decodeErrorResult({ abi: request.abi, data: errorMessage as Hex });
  if (errorName !== expected) throw new Error(`${label}: reverted ${errorName}, expected ${expected}`);

  const tx = { ...(await txRecord(hash, label)), gas: await gasOf(hash) };
  console.log(`  ${label}: ${result.result} ${errorMessage} = ${errorName}() ${tx.hashscan}`);
  return {
    expected,
    tx,
    status: result.result,
    errorMessage: errorMessage as Hex,
    selector: errorMessage.slice(0, 10) as Hex,
    decoded: `${errorName}(${(args ?? []).join(",")})`,
  };
}
