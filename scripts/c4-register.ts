/**
 * C4 (Task 4.3, rulings R9/R11): lender D, the first real receivable registration on the wired registry,
 * its HCS audit events and NFT, and DUPLICATE_RECEIVABLE proven on-chain.
 *
 *   pnpm -r build && pnpm tsx scripts/c4-register.ts      (after scripts/c4-deploy-and-wire.ts)
 *
 * Steps (each skipped when `deployments/testnet/c4.json` shows it done):
 *   1. lender D - a fourth ECDSA lender account (20 HBAR) written to .env.accounts as LENDER_D_ID/_KEY/_EVM,
 *                 USDC associated, 1 USDC from the operator, registered in KYA by the issuer (role 4,
 *                 level 2, ownerGroup keccak("lender-d")) and 50 tUSDT minted to it.
 *   2. register - the buyer signs PO-1002 (6 USDC, due in 30 days, deadline +1 day, payTo = RepaymentRouter,
 *                 nonce = nonces(buyer)); the coordinator submits it. Checked: TS digest = on-chain
 *                 hashConfirmation, computeId, a dry run, then state(id) = Confirmed and the stored record.
 *   3. audit    - `ReceivableConfirmed` to the HCS audit topic, the receivable NFT minted with metadata
 *                 {id, seq} where seq is that event's sequence number, then `NftMinted`.
 *   4. dup      - the same obligation (same buyer and buyerRef, so the same id) signed again with the next
 *                 nonce. A dry run shows it reverts DUPLICATE_RECEIVABLE while the same confirmation with a
 *                 fresh buyerRef would pass; then a REAL transaction (explicit gas) reverts on-chain and the
 *                 selector is decoded from the mirror node's error_message.
 *   5. check    - mirror-node read-back of the registration result, both HCS messages and the NFT metadata.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  associateUsdc,
  contracts,
  createEcdsaAccount,
  hieroClient,
  mintReceivableNft,
  mirror,
  transferUsdc,
  type AuditEvent,
} from "@casheth/hedera";
import {
  ReceivableRegistryAbi,
  computeReceivableId,
  hashReceivableConfirmation,
  hashscan,
  loadAddresses,
  loadHederaIds,
  receivableDomain,
  signReceivableConfirmation,
  type ReceivableConfirmation,
} from "@casheth/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, gasOf, mirrorGet, ROOT, txRecord } from "./spikes/lib.js";
import { publishAuditOnce, proveRevert } from "./lib/c4.js";
import { mintTo, readC4, TUSDT_UNIT, writeC4, type C4State } from "./c4-state.js";

const ENV_ACCOUNTS_PATH = `${ROOT}.env.accounts`;
const DAY = 86_400n;
const FACE = 6_000_000n; // 6 USDC: the lenders' real balances cap the demo at a 4.5 USDC advance
const LENDER_D_USDC = 1_000_000n;

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const addresses = loadAddresses();
const { hcsAuditTopicId: topicId, receivableNftTokenId: nftTokenId } = loadHederaIds();
const registryAddress = getAddress(need("addresses.receivableRegistry", addresses.receivableRegistry));
const repaymentRouter = getAddress(need("addresses.repaymentRouter", addresses.repaymentRouter));
const tUsdt = getAddress(need("addresses.tUsdt (run c4-deploy-and-wire.ts first)", addresses.tUsdt));
const usdc = getAddress(env.USDC_EVM_ADDRESS);
const operator = privateKeyToAccount(env.HEDERA_OPERATOR_KEY as Hex).address;
const buyerAccount = privateKeyToAccount(need("BUYER_KEY", env.BUYER_KEY) as Hex);
const buyer = buyerAccount.address;
const seller = getAddress(need("SELLER_EVM", env.SELLER_EVM));
const submitterKey = need("COORDINATOR_KEY", env.COORDINATOR_KEY) as Hex;
const issuerKey = need("KYA_ISSUER_KEY", env.KYA_ISSUER_KEY) as Hex;
const client = hieroClient(env);
const domain = receivableDomain(296, registryAddress);
const buyerRef = keccak256(toHex("PO-1002"));
const receivableId = computeReceivableId(buyer, buyerRef);

const state: C4State = readC4(operator);
if (!state.deploy || !state.wiring) throw new Error("c4.json has no deploy/wiring: run scripts/c4-deploy-and-wire.ts first");

const stringify = (c: ReceivableConfirmation): Record<string, string> =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)]));

// ------------------------------------------------------------------ 1. lender D

/** Appends `KEY=value` lines that are not yet in .env.accounts; never rewrites existing lines. */
function appendEnvAccounts(entries: [string, string][]): void {
  const current = existsSync(ENV_ACCOUNTS_PATH) ? readFileSync(ENV_ACCOUNTS_PATH, "utf8") : "";
  const have = new Set(current.split("\n").map((l) => l.slice(0, l.indexOf("="))));
  const lines = entries.filter(([k]) => !have.has(k)).map(([k, v]) => `${k}=${v}`);
  if (lines.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(ENV_ACCOUNTS_PATH, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
}

async function lenderD(): Promise<NonNullable<C4State["lenderD"]>> {
  console.log("1. lender D: account, USDC association and funding, KYA, tUSDT");
  let id = env.LENDER_D_ID;
  let key = env.LENDER_D_KEY;
  let evm = env.LENDER_D_EVM as Address | undefined;
  let created: string | undefined = state.lenderD?.created;
  if (!id || !key || !evm) {
    const acct = await createEcdsaAccount(client, { initialHbar: 20, label: "lenderD" });
    ({ accountId: id, privateKey: key, evmAddress: evm } = acct);
    created = acct.txId;
    appendEnvAccounts([
      ["LENDER_D_ID", id],
      ["LENDER_D_KEY", key],
      ["LENDER_D_EVM", evm],
    ]);
    console.log(`  created ${id} (${evm}) ${hashscan.tx(created)}; saved to .env.accounts`);
  } else {
    console.log(`  exists ${id} (${evm})`);
  }
  evm = getAddress(evm);
  const rec: NonNullable<C4State["lenderD"]> = { ...state.lenderD, accountId: id, evm, ...(created ? { created } : {}) };
  state.lenderD = rec;
  writeC4(state);

  const account = await mirror.waitFor(() => mirror.account(env, id), { attempts: 15, delayMs: 2000 });
  if (account.balance.tokens.some((t) => t.token_id === env.USDC_TOKEN_ID)) {
    console.log("  USDC already associated");
  } else {
    rec.usdcAssociation = await associateUsdc(client, id, key, env.USDC_TOKEN_ID);
    console.log(`  associated USDC ${hashscan.tx(rec.usdcAssociation)}`);
    writeC4(state);
  }

  const balance = await mirror.tokenBalance(env, id, env.USDC_TOKEN_ID).catch(() => 0n);
  if (balance >= LENDER_D_USDC) {
    console.log(`  already holds ${balance} USDC units`);
  } else {
    rec.usdcFunding = await transferUsdc(client, {
      tokenId: env.USDC_TOKEN_ID,
      from: env.HEDERA_OPERATOR_ID,
      fromKey: env.HEDERA_OPERATOR_KEY,
      to: id,
      units: LENDER_D_USDC - balance,
    });
    console.log(`  funded ${LENDER_D_USDC - balance} USDC units from the operator ${hashscan.tx(rec.usdcFunding)}`);
    writeC4(state);
  }

  const { kya, clients } = contracts(env, { addresses, walletKey: issuerKey });
  const existing = await kya.read.agent([evm]);
  if (existing.level !== 0) {
    console.log(`  KYA: already registered (level ${existing.level})`);
  } else {
    const agent = {
      uaidHash: keccak256(evm), // placeholder until lender D gets an HCS-14 UAID
      ownerGroup: keccak256(toHex("lender-d")),
      role: 4,
      level: 2,
      expiresAt: 0n,
      revoked: false,
      mandateHash: keccak256(toHex("mandate-v1-lenderD")),
    };
    const gas = ((await kya.estimateGas.register([evm, agent], { account: clients.wallet.account! })) * 13n) / 10n;
    const hash = await kya.write.register([evm, agent], { gas, chain: clients.chain, account: clients.wallet.account! });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`KYA register lender D reverted (${hash})`);
    const after = await kya.read.agent([evm]);
    if (after.level !== 2 || after.role !== 4 || after.ownerGroup !== agent.ownerGroup) {
      throw new Error("KYA register lender D: on-chain agent does not match");
    }
    rec.kya = { ...(await txRecord(hash, "KYARegistry.register(lenderD)")), gas: await gasOf(hash) };
    console.log(`  KYA register (role 4, level 2, lender-d): ${rec.kya.hashscan}`);
    writeC4(state);
  }

  if (!rec.tUsdtMint) {
    rec.tUsdtMint = await mintTo(tUsdt, "LENDER_D", evm, 50n * TUSDT_UNIT);
    writeC4(state);
  }
  return rec;
}

// ------------------------------------------------------------------ 2. register

async function revertName(fn: () => Promise<unknown>): Promise<string> {
  try {
    const r = await fn();
    return `no revert (${String(r)})`;
  } catch (err) {
    const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    return revert instanceof ContractFunctionRevertedError ? `${revert.data?.errorName ?? "?"}()` : String(err);
  }
}

async function register(): Promise<NonNullable<C4State["registration"]>> {
  console.log("2. register: buyer-signed PO-1002, payTo = RepaymentRouter");
  const { registry, kya, clients } = contracts(env, { addresses, walletKey: submitterKey });
  const submitter = clients.wallet.account!.address;
  if ((await registry.read.state([receivableId])) !== 0) {
    throw new Error(`receivable ${receivableId} already exists on-chain but c4.json has no registration tx`);
  }
  const now = (await clients.public.getBlock()).timestamp;
  const c: ReceivableConfirmation = {
    seller,
    buyer,
    currency: usdc,
    amount: FACE,
    dueDate: now + 30n * DAY,
    buyerRef,
    detailsCommitment: keccak256(toHex("demo-invoice-1002")),
    payTo: repaymentRouter,
    nonce: await registry.read.nonces([buyer]),
    deadline: now + DAY,
  };
  const signature = await signReceivableConfirmation(buyerAccount, domain, c);
  const digest = hashReceivableConfirmation(domain, c);
  if ((await registry.read.hashConfirmation([c])) !== digest) throw new Error("TS digest != on-chain hashConfirmation");
  if ((await registry.read.computeId([buyer, buyerRef])) !== receivableId) throw new Error("computeId mismatch");
  const [wired, buyerLevel, sellerLevel] = await Promise.all([
    registry.read.repaymentRouter(),
    kya.read.level([buyer]),
    kya.read.level([seller]),
  ]);
  console.log(`  id ${receivableId}; digest ${digest} matches hashConfirmation`);
  console.log(`  registry.repaymentRouter() = ${wired}; nonce ${c.nonce}; KYA buyer ${buyerLevel}, seller ${sellerLevel}`);

  const { result: simulatedId } = await registry.simulate.register([c, signature], { account: submitter });
  if (simulatedId !== receivableId) throw new Error(`simulate returned ${simulatedId}, expected ${receivableId}`);

  const rec: NonNullable<C4State["registration"]> = {
    confirmation: stringify(c),
    signature,
    digest,
    receivableId,
    submitter,
  };
  state.registration = rec;
  writeC4(state);

  const gas = ((await registry.estimateGas.register([c, signature], { account: clients.wallet.account! })) * 13n) / 10n;
  const hash = await registry.write.register([c, signature], { gas, chain: clients.chain, account: clients.wallet.account! });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`register PO-1002 reverted (${hash})`);
  rec.tx = { ...(await txRecord(hash, "ReceivableRegistry.register(PO-1002)")), gas: await gasOf(hash) };
  console.log(`  registered: ${rec.tx.hashscan} (gas used ${rec.tx.gas.used})`);
  writeC4(state);
  return rec;
}

async function readOnChain(): Promise<Record<string, string>> {
  const { registry } = contracts(env, { addresses });
  const [st, r, nonce] = await Promise.all([
    registry.read.state([receivableId]),
    registry.read.get([receivableId]),
    registry.read.nonces([buyer]),
  ]);
  const c = state.registration!.confirmation;
  const ok =
    st === 1 &&
    r.state === 1 &&
    getAddress(r.seller) === getAddress(c.seller!) &&
    getAddress(r.buyer) === buyer &&
    getAddress(r.currency) === usdc &&
    r.amount === FACE &&
    String(r.dueDate) === c.dueDate &&
    r.detailsCommitment === c.detailsCommitment;
  if (!ok) throw new Error(`on-chain receivable does not match the confirmation: state ${st}`);
  return {
    "state(id)": `${st} (Confirmed)`,
    seller: r.seller,
    buyer: r.buyer,
    currency: r.currency,
    amount: r.amount.toString(),
    dueDate: r.dueDate.toString(),
    registeredAt: r.registeredAt.toString(),
    detailsCommitment: r.detailsCommitment,
    "nonces(buyer) after": nonce.toString(),
  };
}

// ------------------------------------------------------------------ 3. HCS + NFT

const publish = (type: AuditEvent["type"], fields: Record<string, unknown>) =>
  publishAuditOnce(client, topicId, type, receivableId, fields);

function nftMetadata(seq: number): string {
  return JSON.stringify({ id: receivableId, seq });
}

async function mintNft(seq: number): Promise<NonNullable<C4State["nft"]>> {
  const metadata = nftMetadata(seq);
  const existing = await mirrorGet<{ nfts: { serial_number: number; metadata: string }[] }>(
    `/tokens/${nftTokenId}/nfts?limit=100`,
  );
  const prior = existing?.nfts.find((n) => Buffer.from(n.metadata, "base64").toString("utf8") === metadata);
  if (prior) throw new Error(`NFT serial ${prior.serial_number} already carries ${metadata} but c4.json has no record`);
  const { serial, txId } = await mintReceivableNft(client, nftTokenId, { id: receivableId, hcsSeq: seq });
  console.log(`  NFT ${nftTokenId} serial ${serial} metadata ${metadata} ${hashscan.tx(txId)}`);
  return { tokenId: nftTokenId, serial, metadata, txId, hashscan: hashscan.tx(txId) };
}

// ------------------------------------------------------------------ 4. duplicate

async function duplicate(): Promise<NonNullable<C4State["duplicate"]>> {
  console.log("4. dup: the same obligation again with the next nonce");
  const { registry, clients } = contracts(env, { addresses, walletKey: submitterKey });
  const submitter = clients.wallet.account!.address;
  const first = state.registration!.confirmation;
  const now = (await clients.public.getBlock()).timestamp;
  const c: ReceivableConfirmation = {
    seller: getAddress(first.seller!),
    buyer,
    currency: usdc,
    amount: BigInt(first.amount!),
    dueDate: BigInt(first.dueDate!),
    buyerRef,
    detailsCommitment: first.detailsCommitment as Hex,
    payTo: repaymentRouter,
    nonce: await registry.read.nonces([buyer]),
    deadline: now + DAY,
  };
  if (c.nonce !== BigInt(first.nonce!) + 1n) throw new Error(`nonces(buyer) = ${c.nonce}, expected ${BigInt(first.nonce!) + 1n}`);
  const sig = await signReceivableConfirmation(buyerAccount, domain, c);

  const dup = await revertName(() => registry.simulate.register([c, sig], { account: submitter }));
  if (dup !== "DUPLICATE_RECEIVABLE()") throw new Error(`dry run: expected DUPLICATE_RECEIVABLE(), got ${dup}`);
  // Control: the identical confirmation with a fresh buyerRef passes every check (dry run only).
  const control: ReceivableConfirmation = { ...c, buyerRef: keccak256(toHex("PO-1002-control")) };
  const controlSig = await signReceivableConfirmation(buyerAccount, domain, control);
  const { result: controlId } = await registry.simulate.register([control, controlSig], { account: submitter });
  if (controlId !== computeReceivableId(buyer, control.buyerRef)) throw new Error("control dry run returned the wrong id");
  console.log(`  dry run: ${dup}; same confirmation with buyerRef keccak("PO-1002-control") passes (id ${controlId})`);

  const rejection = await proveRevert(
    clients.wallet,
    { address: registryAddress, abi: ReceivableRegistryAbi, functionName: "register", args: [c, sig] },
    "DUPLICATE_RECEIVABLE",
    "register(PO-1002 again, next nonce)",
  );
  return {
    confirmation: stringify(c),
    simulation: { duplicate: dup, freshRefControl: `passes, returns id ${controlId}` },
    rejection,
  };
}

// ------------------------------------------------------------------ 5. mirror check

async function check(): Promise<void> {
  console.log("5. check: mirror node read-back");
  const reg = await mirror.waitFor(() =>
    mirrorGet<{ result: string; to: string }>(`/contracts/results/${state.registration!.tx!.hash}`),
  );
  if (reg.result !== "SUCCESS") throw new Error(`registration result ${reg.result}`);
  console.log(`  registration tx result ${reg.result}`);
  for (const [label, a] of Object.entries(state.audit ?? {})) {
    const m = await mirror.waitFor(() =>
      mirrorGet<{ message: string; sequence_number: number }>(`/topics/${topicId}/messages/${a.seq}`),
    );
    const body = JSON.parse(Buffer.from(m.message, "base64").toString("utf8")) as AuditEvent;
    if (body.id !== receivableId) throw new Error(`${label} seq ${a.seq} carries id ${body.id}`);
    console.log(`  HCS seq ${a.seq}: ${body.type} id ${body.id} prevSeq ${body.prevSeq}`);
  }
  const n = state.nft!;
  const nft = await mirror.waitFor(() =>
    mirrorGet<{ metadata: string; account_id: string; serial_number: number }>(`/tokens/${n.tokenId}/nfts/${n.serial}`),
  );
  const metadata = Buffer.from(nft.metadata, "base64").toString("utf8");
  if (metadata !== n.metadata) throw new Error(`NFT metadata ${metadata} != ${n.metadata}`);
  const parsed = JSON.parse(metadata) as { id: string; seq: number };
  if (parsed.seq !== state.audit!.receivableConfirmed!.seq) throw new Error("NFT seq is not the ReceivableConfirmed seq");
  console.log(`  NFT ${n.tokenId}#${nft.serial_number} held by ${nft.account_id}: ${metadata}`);
}

// ------------------------------------------------------------------ main

state.lenderD = await lenderD();
writeC4(state);

if (state.registration?.tx) console.log(`2. register: done (${state.registration.tx.hashscan})`);
else await register();
state.registration!.onChain = await readOnChain();
writeC4(state);

console.log("3. audit: ReceivableConfirmed, NFT, NftMinted");
const reg = state.registration!;
state.audit ??= {};
state.audit.receivableConfirmed ??= await publish("ReceivableConfirmed", {
  amount: FACE.toString(),
  asset: "USDC",
  txId: reg.tx!.transactionId,
  dueDate: reg.confirmation.dueDate,
  payTo: repaymentRouter,
});
writeC4(state);
state.nft ??= await mintNft(state.audit.receivableConfirmed.seq);
writeC4(state);
state.audit.nftMinted ??= await publish("NftMinted", {
  tokenId: state.nft.tokenId,
  serial: state.nft.serial,
  txId: state.nft.txId,
  confirmedSeq: state.audit.receivableConfirmed.seq,
});
writeC4(state);

if (state.duplicate) console.log(`4. dup: done (${state.duplicate.rejection.tx.hashscan})`);
else {
  state.duplicate = await duplicate();
  writeC4(state);
}

await check();
client.close();

console.log("\nC4 registration summary");
console.log(`  receivable ${receivableId}: ${reg.tx!.hashscan}`);
console.log(`  ReceivableConfirmed seq ${state.audit.receivableConfirmed.seq}, NftMinted seq ${state.audit.nftMinted.seq} (${hashscan.topic(topicId)})`);
console.log(`  NFT ${state.nft.tokenId} serial ${state.nft.serial}`);
console.log(`  DUPLICATE_RECEIVABLE ${state.duplicate.rejection.selector}: ${state.duplicate.rejection.tx.hashscan}`);
