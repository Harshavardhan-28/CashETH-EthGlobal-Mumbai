/**
 * Spike S3: a worker agent pays 0.25 USDC over x402 to our own merchant (`apps/merchant`) on Hedera
 * testnet, first from a single-key account, then from a 2-of-2 threshold-key spend wallet whose
 * second signature comes from a policy co-signer.
 *
 *   pnpm -r build && pnpm tsx scripts/spikes/s3-x402.ts
 *
 * Steps (each skipped when `deployments/testnet/spike-s3.json` shows it done):
 *   A. fund WORKER_RESEARCH with USDC if needed, start the merchant in-process, pay
 *      `GET /research?topic=hedera x402` with the worker's key, check both balances on the mirror node.
 *   B. create the 2-of-2 spend wallet KeyList([worker, cosigner], 2), associate USDC (both sign),
 *      fund it, pay the same endpoint with the co-signed signer, check balances.
 *   C. negative check: the spend wallet pays with the worker signature only (no co-signer); the
 *      facilitator must refuse it and the wallet's USDC must not move.
 * Each part tries the primary facilitator and then the fallbacks, recording every response.
 * Afterwards the "Spike S3" section of docs/EVIDENCE.md is (re)written from the state file.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import {
  addSignature,
  associateUsdc,
  createClientHederaSigner,
  createCosignedHederaSigner,
  createThresholdAccount,
  createX402Fetch,
  hieroClient,
  mirror,
  PrivateKey,
  payX402,
  transferUsdc,
  type ClientHederaSigner,
} from "@casheth/hedera";
import { startMerchant } from "@casheth/merchant";
import { hashscan } from "@casheth/shared";
import { env, mirrorGet, readJson, ROOT, writeJson } from "./lib.js";

const STATE_FILE = `${ROOT}deployments/testnet/spike-s3.json`;
const EVIDENCE_FILE = `${ROOT}docs/EVIDENCE.md`;
const ACCOUNTS_FILE = `${ROOT}.env.accounts`;

const FACILITATORS = [
  "https://x402.org/facilitator",
  "https://api.testnet.blocky402.com",
  "https://testnet.facilitator.launa.dev",
];
const PRICE_UNITS = 250_000n; // 0.25 USDC
const FUND_UNITS = 300_000n;
const PORT = Number(process.env.MERCHANT_PORT ?? 4021);
const URL_PATH = "/research?topic=hedera%20x402";

interface Attempt {
  facilitator: string;
  status: number;
  body: unknown;
  transactionId?: string;
}

interface Payment {
  payer: string;
  facilitator: string;
  feePayer: string;
  requirements: unknown;
  attempts: Attempt[];
  transactionId: string;
  mirrorTransactionId: string;
  hashscan: string;
  consensusTimestamp: string;
  responseBody: unknown;
  usdc: { payer: { before: string; after: string }; merchant: { before: string; after: string } };
}

interface S3State {
  network: "testnet";
  merchant: string;
  usdc: string;
  partA?: Payment & { fundTx?: string };
  spendWallet?: {
    accountId: string;
    threshold: 2;
    keys: { worker: string; cosigner: string };
    createTx: string;
    associateTx: string;
    fundTx?: string;
  };
  partB?: Payment;
  partBFailure?: Attempt[];
  workerOnly?: Attempt & { usdcBefore: string; usdcAfter: string };
}

const required = (name: string): string => {
  const value = env[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} missing from .env.accounts`);
  return value;
};

const WORKER_ID = required("WORKER_RESEARCH_ID");
const WORKER_KEY = PrivateKey.fromStringECDSA(required("WORKER_RESEARCH_KEY"));
const COSIGNER_ID = required("COSIGNER_ID");
const COSIGNER_KEY = PrivateKey.fromStringECDSA(required("COSIGNER_KEY"));
const client = hieroClient(env);

const usdcOf = (account: string): Promise<bigint> => mirror.tokenBalance(env, account, env.USDC_TOKEN_ID);

/** `0.0.x@s.n` (SDK / facilitator) -> `0.0.x-s-n` (mirror node and HashScan path form). */
const toMirrorId = (txId: string): string => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

function loadState(): S3State {
  if (existsSync(STATE_FILE)) return readJson<S3State>(STATE_FILE);
  return { network: "testnet", merchant: env.MERCHANT_ACCOUNT_ID, usdc: env.USDC_TOKEN_ID };
}

async function fundIfLow(account: string, label: string): Promise<string | undefined> {
  const balance = await usdcOf(account);
  if (balance >= PRICE_UNITS) {
    console.log(`  ${label} already holds ${balance} USDC units; no funding`);
    return undefined;
  }
  const txId = await transferUsdc(client, {
    tokenId: env.USDC_TOKEN_ID,
    from: env.HEDERA_OPERATOR_ID,
    fromKey: env.HEDERA_OPERATOR_KEY,
    to: account,
    units: FUND_UNITS,
  });
  await mirror.waitFor(async () => (await usdcOf(account)) === balance + FUND_UNITS, { attempts: 15 });
  console.log(`  funded ${label} with ${FUND_UNITS} units: ${hashscan.tx(toMirrorId(txId))}`);
  return txId;
}

/** The 402 the merchant sends without payment, decoded from the `PAYMENT-REQUIRED` header. */
async function quote(url: string): Promise<{ accepts: { extra?: { feePayer?: string } }[] }> {
  const res = await fetch(url);
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (res.status !== 402 || !header) throw new Error(`expected a 402 with PAYMENT-REQUIRED, got ${res.status}`);
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

interface MirrorTx {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  payer_account_id?: string;
  token_transfers: { token_id: string; account: string; amount: number }[];
}

/**
 * Pays the merchant from `payer` with `signer`, trying each facilitator until one settles, then checks
 * the transfer and both balances on the mirror node.
 */
async function pay(payer: string, signer: ClientHederaSigner): Promise<Payment | { failed: Attempt[] }> {
  const attempts: Attempt[] = [];
  for (const facilitator of FACILITATORS) {
    const payerBefore = await usdcOf(payer);
    const merchantBefore = await usdcOf(env.MERCHANT_ACCOUNT_ID);
    const server = await startMerchant(env, PORT, { facilitatorUrl: facilitator });
    const url = `http://localhost:${PORT}${URL_PATH}`;
    try {
      const required402 = await quote(url);
      const requirements = required402.accepts[0];
      console.log(`  402 via ${facilitator}: ${JSON.stringify(requirements)}`);
      const result = await payX402(createX402Fetch(signer), url);
      const attempt: Attempt = { facilitator, status: result.status, body: result.body, transactionId: result.transactionId };
      attempts.push(attempt);
      console.log(`  paid GET -> HTTP ${result.status}, transactionId ${result.transactionId ?? "-"}`);
      if (result.status !== 200) {
        console.log(`  rejected by ${facilitator}: ${JSON.stringify(result.body)}`);
        continue;
      }
      if (!result.transactionId) throw new Error("HTTP 200 without a settlement transaction id");
      const mirrorTransactionId = toMirrorId(result.transactionId);
      const tx = await mirror.waitFor(
        async () => (await mirrorGet<{ transactions: MirrorTx[] }>(`/transactions/${mirrorTransactionId}`))?.transactions[0],
        { attempts: 15 },
      );
      const moved = (account: string): number =>
        tx.token_transfers
          .filter((t) => t.token_id === env.USDC_TOKEN_ID && t.account === account)
          .reduce((sum, t) => sum + t.amount, 0);
      if (tx.result !== "SUCCESS" || moved(payer) !== -Number(PRICE_UNITS) || moved(env.MERCHANT_ACCOUNT_ID) !== Number(PRICE_UNITS)) {
        throw new Error(`settlement ${mirrorTransactionId} does not show the expected transfer: ${JSON.stringify(tx)}`);
      }
      await mirror.waitFor(async () => (await usdcOf(payer)) === payerBefore - PRICE_UNITS, { attempts: 15 });
      const payerAfter = await usdcOf(payer);
      const merchantAfter = await usdcOf(env.MERCHANT_ACCOUNT_ID);
      if (merchantAfter - merchantBefore !== PRICE_UNITS) {
        throw new Error(`merchant USDC moved ${merchantBefore} -> ${merchantAfter}, expected +${PRICE_UNITS}`);
      }
      console.log(`  settled: ${hashscan.tx(mirrorTransactionId)} (${tx.result})`);
      console.log(`  USDC payer ${payerBefore} -> ${payerAfter}, merchant ${merchantBefore} -> ${merchantAfter}`);
      return {
        payer,
        facilitator,
        feePayer: requirements?.extra?.feePayer ?? "",
        requirements: required402,
        attempts,
        transactionId: result.transactionId,
        mirrorTransactionId,
        hashscan: hashscan.tx(mirrorTransactionId),
        consensusTimestamp: tx.consensus_timestamp,
        responseBody: result.body,
        usdc: {
          payer: { before: payerBefore.toString(), after: payerAfter.toString() },
          merchant: { before: merchantBefore.toString(), after: merchantAfter.toString() },
        },
      };
    } catch (error) {
      if (attempts.at(-1)?.facilitator !== facilitator) {
        attempts.push({ facilitator, status: 0, body: String(error) });
      }
      console.log(`  ${facilitator} failed: ${String(error)}`);
      if (attempts.at(-1)?.status === 200) throw error; // paid but not verifiable: stop, do not pay twice
    } finally {
      await closeServer(server);
    }
  }
  return { failed: attempts };
}

async function partA(state: S3State): Promise<void> {
  if (state.partA) return console.log(`A. single-key payment already settled: ${state.partA.hashscan}`);
  console.log(`A. single-key payment from WORKER_RESEARCH ${WORKER_ID}`);
  const fundTx = await fundIfLow(WORKER_ID, "WORKER_RESEARCH");
  const signer = createClientHederaSigner(WORKER_ID, WORKER_KEY, { network: env.X402_NETWORK });
  const result = await pay(WORKER_ID, signer);
  if ("failed" in result) throw new Error(`part A did not settle: ${JSON.stringify(result.failed)}`);
  state.partA = { ...result, ...(fundTx ? { fundTx } : {}) };
  writeJson(STATE_FILE, state);
}

async function spendWallet(state: S3State): Promise<string> {
  if (state.spendWallet) return state.spendWallet.accountId;
  console.log("B. create 2-of-2 spend wallet KeyList([worker-research, cosigner], 2)");
  const created = await createThresholdAccount(client, {
    publicKeys: [WORKER_KEY.publicKey, COSIGNER_KEY.publicKey],
    threshold: 2,
    initialHbar: 5,
    label: "spike-s3-spend-wallet",
  });
  const associateTx = await associateUsdc(
    client,
    created.accountId,
    [required("WORKER_RESEARCH_KEY"), required("COSIGNER_KEY")],
    env.USDC_TOKEN_ID,
  );
  console.log(`  spend wallet ${created.accountId}: ${hashscan.account(created.accountId)}`);
  console.log(`  associated USDC (both keys signed): ${hashscan.tx(toMirrorId(associateTx))}`);
  state.spendWallet = {
    accountId: created.accountId,
    threshold: 2,
    keys: { worker: WORKER_KEY.publicKey.toStringRaw(), cosigner: COSIGNER_KEY.publicKey.toStringRaw() },
    createTx: created.txId,
    associateTx,
  };
  writeJson(STATE_FILE, state);
  const accounts = readFileSync(ACCOUNTS_FILE, "utf8");
  if (!/^SPIKE_SPEND_WALLET_ID=/m.test(accounts)) {
    appendFileSync(ACCOUNTS_FILE, `${accounts.endsWith("\n") ? "" : "\n"}SPIKE_SPEND_WALLET_ID=${created.accountId}\n`);
  }
  return created.accountId;
}

/** Policy co-signer: signs only a payment of at most 0.25 USDC to our merchant. */
async function cosign(txBase64: string, requirements: { payTo: string; asset: string; amount: string }): Promise<string> {
  const ok =
    requirements.payTo === env.MERCHANT_ACCOUNT_ID &&
    requirements.asset === env.USDC_TOKEN_ID &&
    BigInt(requirements.amount) <= PRICE_UNITS;
  if (!ok) {
    console.log(`  cosigner REFUSED ${JSON.stringify(requirements)}`);
    throw new Error("cosigner policy rejected the payment requirements");
  }
  console.log(`  cosigner approved: ${requirements.amount} of ${requirements.asset} to ${requirements.payTo}`);
  return addSignature(txBase64, COSIGNER_KEY);
}

async function partB(state: S3State): Promise<void> {
  if (state.partB) return console.log(`B. co-signed payment already settled: ${state.partB.hashscan}`);
  const walletId = await spendWallet(state);
  console.log(`B. co-signed payment from spend wallet ${walletId}`);
  const fundTx = await fundIfLow(walletId, "spend wallet");
  if (fundTx) {
    state.spendWallet!.fundTx = fundTx;
    writeJson(STATE_FILE, state);
  }
  const signer = createCosignedHederaSigner({ accountId: walletId, workerKey: WORKER_KEY, network: env.X402_NETWORK, cosign });
  const result = await pay(walletId, signer);
  if ("failed" in result) {
    state.partBFailure = result.failed;
    writeJson(STATE_FILE, state);
    throw new Error(`part B: every facilitator rejected the threshold signature: ${JSON.stringify(result.failed)}`);
  }
  state.partB = result;
  delete state.partBFailure;
  writeJson(STATE_FILE, state);
}

async function partC(state: S3State): Promise<void> {
  if (state.workerOnly || !state.spendWallet) return;
  const walletId = state.spendWallet.accountId;
  console.log(`C. worker-only signature from spend wallet ${walletId} (no co-signer), expect a refusal`);
  const facilitator = state.partB?.facilitator ?? FACILITATORS[0]!;
  const before = await usdcOf(walletId);
  const server = await startMerchant(env, PORT, { facilitatorUrl: facilitator });
  try {
    const signer = createCosignedHederaSigner({
      accountId: walletId,
      workerKey: WORKER_KEY,
      network: env.X402_NETWORK,
      cosign: async (txBase64) => txBase64,
    });
    const result = await payX402(createX402Fetch(signer), `http://localhost:${PORT}${URL_PATH}`);
    await new Promise((r) => setTimeout(r, 6000)); // let the mirror catch up with any (unexpected) debit
    const after = await usdcOf(walletId);
    console.log(`  HTTP ${result.status} ${JSON.stringify(result.body)}; wallet USDC ${before} -> ${after}`);
    if (result.status === 200 || after !== before) throw new Error("a worker-only signature was accepted");
    state.workerOnly = {
      facilitator,
      status: result.status,
      body: result.body,
      usdcBefore: before.toString(),
      usdcAfter: after.toString(),
    };
    writeJson(STATE_FILE, state);
  } finally {
    await closeServer(server);
  }
}

const units = (u: string): string => `${Number(u).toLocaleString("en-US")}`;

function evidence(state: S3State): string {
  const a = state.partA!;
  const lines = [
    "## Spike S3: x402 payment of 0.25 USDC, single key then 2-of-2 co-signed",
    "",
    `A worker agent paid our own x402 merchant (\`apps/merchant\`, \`GET /research?topic=hedera x402\`, price "0.25") in USDC [${env.USDC_TOKEN_ID}](${hashscan.token(env.USDC_TOKEN_ID)}) to merchant [${env.MERCHANT_ACCOUNT_ID}](${hashscan.account(env.MERCHANT_ACCOUNT_ID)}) on \`hedera:testnet\`, settled by a public x402 facilitator that pays the fee. Produced by \`scripts/spikes/s3-x402.ts\` (\`@x402/core\`, \`@x402/hedera\`, \`@x402/express\`, \`@x402/fetch\` 2.30.0); machine-readable record in \`deployments/testnet/spike-s3.json\`.`,
    "",
    "| Payment | Payer | Facilitator (fee payer) | Settlement transaction | HTTP |",
    "| --- | --- | --- | --- | --- |",
    `| A: single ECDSA key | WORKER_RESEARCH [${a.payer}](${hashscan.account(a.payer)}) | ${a.facilitator} (${a.feePayer}) | [${a.transactionId}](${a.hashscan}) | 200 |`,
  ];
  const b = state.partB;
  const w = state.spendWallet;
  if (b && w) {
    lines.push(
      `| B: 2-of-2 KeyList (worker + policy co-signer) | spend wallet [${b.payer}](${hashscan.account(b.payer)}) | ${b.facilitator} (${b.feePayer}) | [${b.transactionId}](${b.hashscan}) | 200 |`,
    );
  }
  lines.push(
    "",
    "| USDC (6-dec units, mirror) | Before | After |",
    "| --- | --- | --- |",
    `| A payer WORKER_RESEARCH \`${a.payer}\` | ${units(a.usdc.payer.before)} | ${units(a.usdc.payer.after)} |`,
    `| A merchant \`${env.MERCHANT_ACCOUNT_ID}\` | ${units(a.usdc.merchant.before)} | ${units(a.usdc.merchant.after)} |`,
  );
  if (b) {
    lines.push(
      `| B payer spend wallet \`${b.payer}\` | ${units(b.usdc.payer.before)} | ${units(b.usdc.payer.after)} |`,
      `| B merchant \`${env.MERCHANT_ACCOUNT_ID}\` | ${units(b.usdc.merchant.before)} | ${units(b.usdc.merchant.after)} |`,
    );
  }
  lines.push(
    "",
    "402 PaymentRequirements returned by the merchant (decoded `PAYMENT-REQUIRED` header, part A):",
    "",
    "```json",
    JSON.stringify(a.requirements, null, 2),
    "```",
    "",
  );
  if (w) {
    lines.push(
      `Spend wallet [${w.accountId}](${hashscan.account(w.accountId)}): key \`KeyList([worker-research ${w.keys.worker.slice(0, 12)}…, cosigner ${COSIGNER_ID} ${w.keys.cosigner.slice(0, 12)}…], threshold 2)\`, no EVM alias, created in [${w.createTx}](${hashscan.tx(toMirrorId(w.createTx))}), USDC associated with both signatures in [${w.associateTx}](${hashscan.tx(toMirrorId(w.associateTx))})${w.fundTx ? `, funded 300,000 units in [${w.fundTx}](${hashscan.tx(toMirrorId(w.fundTx))})` : ""}. The worker key signs the facilitator-paid TransferTransaction (built by \`@x402/hedera\`'s \`createClientHederaSigner\`), then the policy co-signer adds its signature only after checking \`payTo\`, \`asset\` and \`amount <= 250000\`. The facilitator's \`/verify\` accepted the two signatures against the wallet's on-chain KeyList and its \`/settle\` reached consensus with \`SUCCESS\`.`,
      "",
    );
  }
  if (state.workerOnly) {
    const n = state.workerOnly;
    lines.push(
      `Negative check: the same wallet paying with the worker signature only (no co-signer) was refused by ${n.facilitator}: HTTP ${n.status} \`${JSON.stringify(n.body)}\`; the wallet's USDC stayed at ${units(n.usdcBefore)} → ${units(n.usdcAfter)}.`,
      "",
    );
  }
  lines.push(
    "Each settlement was checked on the mirror node (\`/api/v1/transactions/<id>\`, id form \`0.0.x-seconds-nanos\`): result \`SUCCESS\`, type \`CRYPTOTRANSFER\`, USDC −250,000 from the payer and +250,000 to the merchant; the transaction id's account is the facilitator's fee payer.",
    "",
  );
  const failed = (b?.attempts ?? state.partBFailure ?? []).filter((x) => x.status !== 200);
  if (failed.length) {
    lines.push("Facilitator responses that did not settle (part B):", "");
    for (const f of failed) lines.push(`- ${f.facilitator}: HTTP ${f.status} \`${JSON.stringify(f.body)}\``);
    lines.push("");
  }
  if (b) {
    lines.push(
      "Paid response body (part B), with `paidWith.transactionId` taken from the settlement:",
      "",
      "```json",
      JSON.stringify(b.responseBody, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

function writeEvidence(state: S3State): void {
  const doc = readFileSync(EVIDENCE_FILE, "utf8");
  const section = evidence(state);
  const start = doc.indexOf("## Spike S3");
  const next = start === -1 ? -1 : doc.indexOf("\n## ", start + 1);
  const updated =
    start === -1
      ? `${doc.trimEnd()}\n\n${section}`
      : `${doc.slice(0, start)}${section}${next === -1 ? "" : `\n${doc.slice(next + 1)}`}`;
  writeFileSync(EVIDENCE_FILE, `${updated.trimEnd()}\n`);
}

const state = loadState();
try {
  await partA(state);
  await partB(state);
  await partC(state);
} finally {
  if (state.partA) writeEvidence(state);
  client.close();
}
