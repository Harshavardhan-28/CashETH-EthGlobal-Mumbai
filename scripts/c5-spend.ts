/**
 * C5 spend (Task 5.3L): two-phase x402 spending on the facility funded for PO-1002, driven through the MCP server's
 * tools by the 7.1 agents (seller `set_budgets`, worker `buy`). The standing allowance is granted first by
 * scripts/c5-allowance.ts. Needs the merchant (:3003), the auth server (:4020) and the MCP server (:4030, with
 * `AGENT_KEYS_IN_PROCESS=true` and `MERCHANT_ORIGINS=<merchant account>=http://localhost:3003`) running.
 *
 *   pnpm -r build && pnpm tsx scripts/c5-spend.ts
 *
 * Steps (each is skipped on a re-run when `deployments/testnet/c5.json` has it):
 *   1. budgets    - seller `set_budgets`: research 1.0 USDC (maxPerTx 0.5, maxDaily 2.0), compute 3.0 USDC.
 *   2. purchase   - research worker buys `/research` (0.25 USDC): reserve, x402 pay through the facilitator with
 *                   the 2-of-2 co-signed wallet, commit. The mirror node and HCS show every leg.
 *   3. rejections - 0.6 USDC (TX_LIMIT_EXCEEDED) and 5.5 USDC (AGENT_BUDGET_EXCEEDED) refused by the engine with no
 *                   transaction, then the contract's own AGENT_BUDGET_EXCEEDED revert for 5.5 sent by the coordinator.
 *   4. expiry     - a 120 s reservation is left unpaid: the late payment is refused, the co-signer's policy says
 *                   `reservation_expired`, the public `release` reverts NOT_COORDINATOR until expiry + 1 h, and the
 *                   coordinator releases it through the standing allowance (USDC returns to the facility).
 */
import { existsSync } from "node:fs";
import { createWorkerAgent, AgentClient, ToolCallError } from "../agents/src/index.js";
import { approvePayment } from "@casheth/engine";
import { contracts, hieroClient, longZeroEvmAddress, mirror, readAuditMessages } from "@casheth/hedera";
import { CreditFacilityAbi, hashscan, loadAddresses, loadHederaIds } from "@casheth/shared";
import { getAddress, keccak256, toHex, zeroHash, type Address, type Hex } from "viem";
import { publishAuditOnce, proveRevert, walletFor } from "./lib/c4.js";
import type { Rejection, Step } from "./c4-state.js";
import { env, gasOf, mirrorGet, pub, readJson, ROOT, send, txRecord, writeJson } from "./spikes/lib.js";

const C5_FILE = `${ROOT}deployments/testnet/c5.json`;
const WALLETS_FILE = `${ROOT}deployments/testnet/spend-wallets.json`;
const MCP_URL = process.env.MCP_RESOURCE_URL ?? "http://localhost:4030/mcp";
const MERCHANT_URL = process.env.C5_MERCHANT_URL ?? "http://localhost:3003";
const RESERVATION_RELEASED = 3;

const vars = env as unknown as Record<string, string | undefined>;
const need = (name: string): string => {
  const v = vars[name];
  if (!v) throw new Error(`${name} missing from .env.accounts`);
  return v;
};

// ---------------------------------------------------------------- state

type TxLink = { transactionId: string; hashscan: string };
type Transfer = { token: string; account: string; amount: string };
type Accounting = { facilityReserved: string; facilityCommitted: string; walletUsdc: Record<string, string>; budget: Record<string, string> };

interface C5State {
  network: "testnet";
  receivableId: Hex;
  facility: Address;
  budgets?: { tx: Step; research: Record<string, string>; compute: Record<string, string> };
  purchase?: {
    purchaseId: string;
    spendId: Hex;
    amount: string;
    reserve: { tx: Step; transfers: Transfer[] };
    settlement: { transactionId: string; hashscan: string; transfers: Transfer[] };
    commit: { tx: Step; hederaTxId: string };
    hcs: HcsRef[];
    accounting: Accounting;
  };
  rejections?: {
    engine: { label: string; worker: string; amount: string; code: string; stage: string; hcs?: HcsRef }[];
    contract: Rejection;
  };
  expiry?: {
    spendId: Hex;
    amount: string;
    ttlSeconds: number;
    reserve: { tx: Step; expiry: number };
    latePayment: { code: string; message: string; hcs?: HcsRef };
    cosignerPolicy: { requirements: Record<string, unknown>; atExpiry: unknown; justBeforeExpiry: unknown };
    publicRelease: Rejection;
    release: { tx: Step; transfers: Transfer[]; status: number };
    hcs: HcsRef[];
    accounting: Accounting;
  };
  updatedAt?: string;
}
type HcsRef = { type: string; seq: number; txId?: string; hashscan?: string };

const { receivableId } = readJson<{ receivableId: Hex }>(`${ROOT}deployments/testnet/facility.json`);
const addresses = loadAddresses();
const facility = addresses.creditFacility as Address;
const state: C5State = existsSync(C5_FILE)
  ? readJson<C5State>(C5_FILE)
  : { network: "testnet", receivableId, facility };
const save = () => writeJson(C5_FILE, { ...state, updatedAt: new Date().toISOString() });

// ---------------------------------------------------------------- helpers

const wallets = readJson<{ wallets: Record<string, { accountId: string; evmAddress: Address }> }>(WALLETS_FILE).wallets;
const merchant = longZeroEvmAddress(env.MERCHANT_ACCOUNT_ID);
const { hcsAuditTopicId: topicId } = loadHederaIds();

const { kya } = contracts(env, { addresses });

/** An MCP client for a demo agent; its assertion carries the mandate hash registered in the KYA registry. */
async function agent(prefix: string, role: "seller" | "worker") {
  const raw = need(`${prefix}_KEY`);
  const address = getAddress(need(`${prefix}_EVM`));
  const { mandateHash } = await kya.read.agent([address]);
  const client = AgentClient.connect({
    agentKey: (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex,
    uaid: need(`${prefix}_UAID`),
    role,
    mandateHash,
    mcpUrl: MCP_URL,
    callTimeoutMs: 240_000,
  });
  return { client, address };
}
const seller = await agent("SELLER", "seller");
const research = await agent("WORKER_RESEARCH", "worker");
const compute = await agent("WORKER_COMPUTE", "worker");
const researchWallet = wallets.SPEND_WALLET_RESEARCH!;
const computeWallet = wallets.SPEND_WALLET_COMPUTE!;

const mirrorTxId = (transactionId: string) => transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** The USDC movements of a transaction (parent and children) as the mirror node reports them. */
async function transfersOf(transactionId: string): Promise<Transfer[]> {
  const { transactions } = await mirror.waitFor(
    () => mirrorGet<{ transactions: { token_transfers?: { token_id: string; account: string; amount: number }[] }[] }>(`/transactions/${mirrorTxId(transactionId)}`),
    { attempts: 20 },
  );
  return transactions
    .flatMap((t) => t.token_transfers ?? [])
    .filter((t) => t.token_id === env.USDC_TOKEN_ID)
    .map((t) => ({ token: t.token_id, account: t.account, amount: String(t.amount) }));
}

/** The HCS audit messages of `type` that satisfy `match`, newest last, with the topic message's own transaction. */
async function hcsEvents(type: string, match: (m: Record<string, unknown>) => boolean): Promise<(HcsRef & { message: Record<string, unknown> })[]> {
  const messages = await readAuditMessages(env, topicId, { limit: 100 });
  return messages
    .filter((m) => m.message.type === type && match(m.message))
    .map((m) => {
      const txId = m.txId ?? m.consensusTimestamp;
      return { type, seq: m.sequenceNumber, txId, hashscan: hashscan.tx(txId), message: m.message };
    });
}
const strip = ({ message: _m, ...ref }: HcsRef & { message: Record<string, unknown> }): HcsRef => ref;

/** Waits for the audit event the server publishes (best effort, a few seconds behind the tool call). */
async function awaitEvent(type: string, match: (m: Record<string, unknown>) => boolean): Promise<HcsRef & { message: Record<string, unknown> }> {
  const found = await mirror.waitFor(async () => (await hcsEvents(type, match)).at(-1), { attempts: 20, delayMs: 3000 });
  console.log(`  HCS ${type} seq ${found.seq} ${found.hashscan}`);
  return found;
}

async function step(hash: Hex, label: string): Promise<Step> {
  return { ...(await txRecord(hash, label)), gas: await gasOf(hash) };
}

async function accounting(): Promise<Accounting> {
  const [info, ...rest] = await Promise.all([
    pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "facilityInfo", args: [receivableId] }),
    pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "budget", args: [receivableId, research.address] }),
    pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "budget", args: [receivableId, compute.address] }),
    mirror.tokenBalance(env, researchWallet.accountId, env.USDC_TOKEN_ID),
    mirror.tokenBalance(env, computeWallet.accountId, env.USDC_TOKEN_ID),
  ]);
  const [rb, cb, rw, cw] = rest as [{ alloc: bigint; spent: bigint; reserved: bigint }, { alloc: bigint; spent: bigint; reserved: bigint }, bigint, bigint];
  const b = (x: { alloc: bigint; spent: bigint; reserved: bigint }) => `alloc ${x.alloc} spent ${x.spent} reserved ${x.reserved}`;
  return {
    facilityReserved: info.reserved.toString(),
    facilityCommitted: info.committed.toString(),
    walletUsdc: { research: rw.toString(), compute: cw.toString() },
    budget: { research: b(rb), compute: b(cb) },
  };
}

const reservationOf = (spendId: Hex) =>
  pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "reservation", args: [spendId] }) as Promise<{ status: number; expiry: bigint; amount: bigint }>;

// ---------------------------------------------------------------- 1. budgets

async function setBudgets(): Promise<NonNullable<C5State["budgets"]>> {
  console.log("1. budgets: seller set_budgets");
  const sent = await seller.client.call<{ mode: string; txHash: Hex }>("set_budgets", {
    id: receivableId,
    budgets: [
      { worker: research.address, alloc: "1000000", maxPerTx: "500000", maxDaily: "2000000", merchants: [merchant] },
      { worker: compute.address, alloc: "3000000", maxPerTx: "10000000", maxDaily: "10000000", merchants: [merchant] },
    ],
    idempotencyKey: "c5-set-budgets-1",
  });
  if (sent.mode !== "sent") throw new Error(`set_budgets returned ${sent.mode}; the server must hold the seller key (AGENT_KEYS_IN_PROCESS=true)`);
  const tx = await step(sent.txHash, "CreditFacility.setBudgets(PO-1002: research 1.0, compute 3.0) via MCP set_budgets");
  const read = async (w: Address) => {
    const b = await pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "budget", args: [receivableId, w] });
    return { alloc: b.alloc.toString(), maxPerTx: b.maxPerTx.toString(), maxDaily: b.maxDaily.toString() };
  };
  return { tx, research: await read(research.address), compute: await read(compute.address) };
}

// ---------------------------------------------------------------- 2. purchase

async function purchase(): Promise<NonNullable<C5State["purchase"]>> {
  console.log("2. purchase: research worker buys /research (reserve, x402 pay, commit)");
  const purchaseId = "po1002-research-1";
  const worker = createWorkerAgent({
    client: research.client,
    worker: research.address,
    spendWallet: researchWallet.evmAddress,
    catalogUrls: [`${MERCHANT_URL}/catalog`],
  });
  const outcome = await worker.buy({ id: receivableId, service: "research", budgetHint: 500_000n, purchaseId, query: "agent working capital" });
  if (outcome.status !== "committed") throw new Error(`purchase did not commit: ${JSON.stringify(outcome)}`);
  const { spendId, transactionId } = outcome;
  console.log(`  x402 settlement ${transactionId} ${hashscan.tx(transactionId)}`);

  const matches = (m: Record<string, unknown>) => m.spendId === spendId;
  const reserved = await awaitEvent("SpendReserved", matches);
  const committed = await awaitEvent("SpendCommitted", matches);
  const reserveTx = await step(reserved.message.txHash as Hex, "CreditFacility.reserve(PO-1002, research 0.25 USDC) via MCP reserve_spend");
  const commitTx = await step(committed.message.txHash as Hex, "CreditFacility.commit(spendId, keccak256(settlement tx id)) via MCP commit_spend");
  if (committed.message.txId !== transactionId) throw new Error("SpendCommitted does not carry the settlement transaction id");
  if (committed.message.txIdHash !== keccak256(toHex(transactionId))) throw new Error("SpendCommitted txIdHash does not match the settlement transaction id");

  const reserveTransfers = await transfersOf(reserveTx.transactionId);
  const settlementTransfers = await transfersOf(transactionId);
  const moved = (ts: Transfer[], account: string, amount: string) => ts.some((t) => t.account === account && t.amount === amount);
  const facilityId = (await mirror.contract(env, facility)).contract_id!;
  if (!moved(reserveTransfers, facilityId, "-250000") || !moved(reserveTransfers, researchWallet.accountId, "250000")) {
    throw new Error(`reserve tx does not show facility -> spend wallet: ${JSON.stringify(reserveTransfers)}`);
  }
  if (!moved(settlementTransfers, researchWallet.accountId, "-250000") || !moved(settlementTransfers, env.MERCHANT_ACCOUNT_ID, "250000")) {
    throw new Error(`settlement does not show spend wallet -> merchant: ${JSON.stringify(settlementTransfers)}`);
  }
  return {
    purchaseId,
    spendId,
    amount: outcome.price.toString(),
    reserve: { tx: reserveTx, transfers: reserveTransfers },
    settlement: { transactionId, hashscan: hashscan.tx(transactionId), transfers: settlementTransfers },
    commit: { tx: commitTx, hederaTxId: transactionId },
    hcs: [strip(reserved), strip(committed)],
    accounting: await accounting(),
  };
}

// ---------------------------------------------------------------- 3. rejections

async function rejections(): Promise<NonNullable<C5State["rejections"]>> {
  console.log("3. rejections: engine and contract");
  const engine: NonNullable<C5State["rejections"]>["engine"] = [];
  const cases = [
    { label: "research worker asks 0.6 USDC (maxPerTx 0.5)", who: research, wallet: researchWallet, amount: "600000", expected: "TX_LIMIT_EXCEEDED" },
    { label: "compute worker asks 5.5 USDC (budget 3.0)", who: compute, wallet: computeWallet, amount: "5500000", expected: "AGENT_BUDGET_EXCEEDED" },
  ];
  for (const c of cases) {
    try {
      await c.who.client.call("reserve_spend", {
        id: receivableId,
        worker: c.who.address,
        spendWallet: c.wallet.evmAddress,
        merchant,
        amount: c.amount,
        idempotencyKey: `c5-reject-${c.expected}`,
      });
      throw new Error(`${c.label}: the reservation was accepted`);
    } catch (error) {
      if (!(error instanceof ToolCallError)) throw error;
      if (error.code !== c.expected || error.details.stage !== "engine") {
        throw new Error(`${c.label}: got ${error.code} (${String(error.details.stage)}), expected ${c.expected} from the engine`);
      }
      console.log(`  ${c.label}: ${error.code} (engine, no transaction)`);
      const event = await awaitEvent("SpendRejected", (m) => m.code === c.expected && m.worker === c.who.address && m.amount === c.amount);
      engine.push({ label: c.label, worker: c.who.address, amount: c.amount, code: error.code, stage: String(error.details.stage), hcs: strip(event) });
    }
  }

  const now = (await pub.getBlock()).timestamp;
  const contract = await proveRevert(
    walletFor("COORDINATOR"),
    {
      address: facility,
      abi: CreditFacilityAbi,
      functionName: "reserve",
      args: [receivableId, keccak256(toHex("c5-contract-budget-revert")), compute.address, computeWallet.evmAddress, merchant, 5_500_000n, now + 600n],
    },
    "AGENT_BUDGET_EXCEEDED",
    "CreditFacility.reserve(compute 5.5 USDC) from the coordinator",
  );
  return { engine, contract };
}

// ---------------------------------------------------------------- 4. expiry

/** Unix seconds of the latest block (the contract's `block.timestamp`). */
const chainNow = async () => (await pub.getBlock()).timestamp;

async function expiry(): Promise<NonNullable<C5State["expiry"]>> {
  console.log("4. expiry: a 120 s reservation left unpaid");
  const ttlSeconds = 120;
  const reserved = await research.client.call<{ spendId: Hex; expiry: number; txHash: Hex }>("reserve_spend", {
    id: receivableId,
    worker: research.address,
    spendWallet: researchWallet.evmAddress,
    merchant,
    amount: "250000",
    ttlSeconds,
    idempotencyKey: "c5-expiry-reserve",
  });
  const { spendId } = reserved;
  const reserveTx = await step(reserved.txHash, "CreditFacility.reserve(PO-1002, research 0.25 USDC, ttl 120 s) via MCP reserve_spend");
  console.log(`  reserved ${spendId}, expiry ${reserved.expiry}; waiting for it to pass`);
  while ((await chainNow()) <= BigInt(reserved.expiry)) await new Promise((r) => setTimeout(r, 5_000));

  // The late payment, through the tool.
  let latePayment: NonNullable<C5State["expiry"]>["latePayment"];
  try {
    await research.client.call("pay_x402", { spendId, url: `${MERCHANT_URL}/research?topic=late`, idempotencyKey: "c5-expiry-pay" });
    throw new Error("the late payment was accepted");
  } catch (error) {
    if (!(error instanceof ToolCallError) || error.code !== "RESERVATION_EXPIRED") throw error;
    const event = await awaitEvent("SpendRejected", (m) => m.spendId === spendId && m.code === "RESERVATION_EXPIRED");
    latePayment = { code: error.code, message: String(error.details.message), hcs: strip(event) };
    console.log(`  pay_x402 after expiry: ${error.code}`);
  }

  // The co-signer's own policy on the real 402 quote and the real reservation.
  const quote = await fetch(`${MERCHANT_URL}/research?topic=late`);
  const header = quote.headers.get("payment-required");
  if (quote.status !== 402 || !header) throw new Error(`merchant answered ${quote.status} without PAYMENT-REQUIRED`);
  const requirements = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const r = await reservationOf(spendId);
  const input = {
    requirements: requirements as unknown as Parameters<typeof approvePayment>[0]["requirements"],
    reservation: { spendId, spendWalletId: researchWallet.accountId, merchantAccountId: env.MERCHANT_ACCOUNT_ID, amount: r.amount, expiry: r.expiry },
    usdcTokenId: env.USDC_TOKEN_ID,
    network: env.X402_NETWORK,
    payerAccountId: researchWallet.accountId,
  };
  const atExpiry = approvePayment({ ...input, now: await chainNow() });
  const justBefore = approvePayment({ ...input, now: r.expiry - 1n });
  if (atExpiry.ok || atExpiry.reason !== "reservation_expired" || !justBefore.ok) {
    throw new Error(`unexpected co-signer verdicts: ${JSON.stringify({ atExpiry, justBefore })}`);
  }
  console.log(`  co-signer policy: ${JSON.stringify(atExpiry)} after expiry, ${JSON.stringify(justBefore)} one second earlier`);

  // Release: the public path needs expiry + 1 h, the coordinator may release at any time.
  const publicRelease = await proveRevert(
    walletFor("SELLER"),
    { address: facility, abi: CreditFacilityAbi, functionName: "release", args: [spendId] },
    "NOT_COORDINATOR",
    "CreditFacility.release(spendId) from the seller, 1 h grace not over",
  );
  const releaseTx = await send(
    "CreditFacility.release(spendId) from the coordinator",
    { address: facility, abi: CreditFacilityAbi, functionName: "release", args: [spendId] },
    walletFor("COORDINATOR"),
  );
  const releaseTransfers = await transfersOf(releaseTx.transactionId);
  const after = await reservationOf(spendId);
  const open = await pub.readContract({ address: facility, abi: CreditFacilityAbi, functionName: "openReservationOf", args: [researchWallet.evmAddress] });
  if (after.status !== RESERVATION_RELEASED || open !== zeroHash) throw new Error(`reservation not released: status ${after.status}, open ${open}`);
  const facilityId = (await mirror.contract(env, facility)).contract_id!;
  if (!releaseTransfers.some((t) => t.account === facilityId && t.amount === "250000")) {
    throw new Error(`release does not show the USDC returning to the facility: ${JSON.stringify(releaseTransfers)}`);
  }

  // `release` emits no audit event of its own: record it on the topic like the other spend events.
  const client = hieroClient(env);
  let released;
  try {
    released = await publishAuditOnce(client, topicId, "SpendReleased", receivableId, {
      spendId,
      amount: "250000",
      asset: env.USDC_TOKEN_ID,
      txHash: releaseTx.hash,
      agent: getAddress(need("COORDINATOR_EVM")),
    });
  } finally {
    client.close();
  }
  return {
    spendId,
    amount: "250000",
    ttlSeconds,
    reserve: { tx: reserveTx, expiry: reserved.expiry },
    latePayment,
    cosignerPolicy: { requirements, atExpiry, justBeforeExpiry: justBefore },
    publicRelease,
    release: { tx: releaseTx, transfers: releaseTransfers, status: after.status },
    hcs: [{ type: "SpendReleased", seq: released.seq, txId: released.txId, hashscan: released.hashscan }],
    accounting: await accounting(),
  };
}

// ---------------------------------------------------------------- main

try {
  state.budgets ??= await setBudgets();
  save();
  state.purchase ??= await purchase();
  save();
  state.rejections ??= await rejections();
  save();
  state.expiry ??= await expiry();
  save();
  console.log("C5 spend complete: deployments/testnet/c5.json");
} finally {
  await Promise.all([seller.client.close(), research.client.close(), compute.client.close()]);
}
