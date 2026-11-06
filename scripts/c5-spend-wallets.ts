/**
 * Checkpoint C5 (wallets): creates each worker's 2-of-2 spend wallet, key
 * `KeyList([worker, cosigner], 2)` without an EVM alias, funded with 5 HBAR by the operator, and
 * associates USDC with it (worker and co-signer both sign). The standing USDC allowance to the
 * CreditFacility is NOT granted here: the facility is not deployed yet, so C5 spend (Task 5.3) calls
 * `approveFacilityAllowance` with its contract id.
 *
 * Idempotent: a wallet whose `<NAME>_ID` is already in .env.accounts is reused (its mirror-node key
 * is checked against the worker and co-signer keys), and USDC is associated only when the mirror node
 * shows no relationship. New ids are appended to .env.accounts right after creation.
 *
 *   pnpm -r build && pnpm tsx scripts/c5-spend-wallets.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  associateSpendWalletUsdc,
  createSpendWallet,
  decodeMirrorKey,
  hieroClient,
  longZeroEvmAddress,
  mirror,
  PrivateKey,
  type DecodedKey,
} from "@casheth/hedera";
import { hashscan, loadEnv } from "@casheth/shared";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_ACCOUNTS_PATH = `${ROOT}.env.accounts`;
const STATE_PATH = `${ROOT}deployments/testnet/spend-wallets.json`;
const EVIDENCE_PATH = `${ROOT}docs/EVIDENCE.md`;
const EVIDENCE_HEADING = "## C5: spend wallets";
const INITIAL_HBAR = 5;

const WALLETS = [
  { name: "SPEND_WALLET_RESEARCH", worker: "WORKER_RESEARCH", label: "spend-wallet-research" },
  { name: "SPEND_WALLET_COMPUTE", worker: "WORKER_COMPUTE", label: "spend-wallet-compute" },
] as const;
type WalletName = (typeof WALLETS)[number]["name"];

interface TxLink {
  transactionId: string;
  hashscan: string;
}

interface WalletRecord {
  accountId: string;
  evmAddress: `0x${string}`;
  hashscan: string;
  worker: { name: string; accountId: string };
  keyList: {
    description: string;
    threshold: number;
    keys: { role: "worker" | "cosigner"; type: string; publicKey: string }[];
    mirrorKey: { _type: string; key: string };
  };
  initialHbar: number;
  maxAutomaticTokenAssociations: number;
  createTx: TxLink;
  usdcAssociateTx: TxLink;
}

interface State {
  network: "testnet";
  usdcTokenId: string;
  cosigner: { accountId: string };
  wallets: Partial<Record<WalletName, WalletRecord>>;
  facilityAllowance: { status: "pending"; note: string };
  updatedAt?: string;
}

const env = loadEnv();
const vars = env as unknown as Record<string, string | undefined>;
const required = (name: string): string => {
  const value = vars[name];
  if (!value) throw new Error(`${name} missing from .env.accounts; run pnpm setup:accounts first`);
  return value;
};

const client = hieroClient(env);
const cosignerKey = PrivateKey.fromStringECDSA(required("COSIGNER_KEY"));
const link = (transactionId: string): TxLink => ({ transactionId, hashscan: hashscan.tx(transactionId) });

function readState(): State {
  const fresh: State = {
    network: "testnet",
    usdcTokenId: env.USDC_TOKEN_ID,
    cosigner: { accountId: required("COSIGNER_ID") },
    wallets: {},
    facilityAllowance: {
      status: "pending",
      note: "The standing USDC allowance to the CreditFacility contract is granted in C5 spend (Task 5.3) with approveFacilityAllowance, once the facility is deployed.",
    },
  };
  if (!existsSync(STATE_PATH)) return fresh;
  const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { ...fresh, wallets: saved.wallets ?? {} };
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Appends `KEY=value` lines that are not yet in .env.accounts; never rewrites existing lines. */
function appendEnvAccounts(entries: [string, string][]): void {
  const current = existsSync(ENV_ACCOUNTS_PATH) ? readFileSync(ENV_ACCOUNTS_PATH, "utf8") : "";
  const existing = new Map(
    current
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const had = existing.get(key);
    if (had === undefined) lines.push(`${key}=${value}`);
    else if (had !== value) throw new Error(`.env.accounts already has ${key} with a different value`);
  }
  if (lines.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(ENV_ACCOUNTS_PATH, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
}

/** Fails unless the mirror node shows exactly KeyList([worker, cosigner], 2). */
function checkKey(name: string, decoded: DecodedKey, workerPub: string, cosignerPub: string): void {
  const ok =
    decoded.threshold === 2 &&
    decoded.keys.length === 2 &&
    decoded.keys.every((k) => k.type === "ECDSA_SECP256K1") &&
    decoded.keys[0]!.publicKey === workerPub &&
    decoded.keys[1]!.publicKey === cosignerPub;
  if (!ok) throw new Error(`${name}: mirror key is not KeyList([worker, cosigner], 2): ${JSON.stringify(decoded)}`);
}

async function ensureWallet(state: State, w: (typeof WALLETS)[number]): Promise<WalletRecord> {
  const workerKey = PrivateKey.fromStringECDSA(required(`${w.worker}_KEY`));
  const workerPub = workerKey.publicKey.toStringRaw();
  const cosignerPub = cosignerKey.publicKey.toStringRaw();
  const saved = state.wallets[w.name];

  // 1. Account (reused when .env.accounts already names it).
  let accountId = vars[`${w.name}_ID`];
  let createTxId: string | undefined;
  if (accountId) {
    console.log(`${w.name}: exists ${accountId}`);
  } else {
    const created = await createSpendWallet(client, {
      workerPub: workerKey.publicKey,
      cosignerPub: cosignerKey.publicKey,
      initialHbar: INITIAL_HBAR,
      label: w.label,
    });
    accountId = created.accountId;
    createTxId = created.txId;
    appendEnvAccounts([
      [`${w.name}_ID`, created.accountId],
      [`${w.name}_EVM`, created.evmAddress],
    ]);
    console.log(`${w.name}: created ${accountId} ${hashscan.tx(createTxId)}`);
  }
  const evmAddress = longZeroEvmAddress(accountId);
  appendEnvAccounts([[`${w.name}_EVM`, evmAddress]]);

  // 2. Key structure as the mirror node reports it.
  const account = await mirror.waitFor(async () => {
    const a = await mirror.account(env, accountId!);
    return a.key ? a : undefined;
  }, { attempts: 15 });
  const mirrorKey = account.key!;
  const decoded = decodeMirrorKey(mirrorKey);
  checkKey(w.name, decoded, workerPub, cosignerPub);
  if (account.evm_address.toLowerCase() !== evmAddress) {
    throw new Error(`${w.name}: mirror evm_address ${account.evm_address} is not the long-zero ${evmAddress}`);
  }
  createTxId ??= saved?.createTx.transactionId ?? (await mirror.transactionIdAt(env, account.created_timestamp!));

  // 3. USDC association, signed by worker and co-signer.
  let associateTxId: string;
  const relationship = await mirror.tokenRelationship(env, accountId, env.USDC_TOKEN_ID);
  if (relationship) {
    associateTxId = saved?.usdcAssociateTx.transactionId ?? (await mirror.transactionIdAt(env, relationship.created_timestamp));
    console.log(`${w.name}: USDC already associated`);
  } else {
    associateTxId = await associateSpendWalletUsdc(client, {
      accountId,
      keys: [workerKey, cosignerKey],
      tokenId: env.USDC_TOKEN_ID,
    });
    await mirror.waitFor(() => mirror.tokenRelationship(env, accountId!, env.USDC_TOKEN_ID), { attempts: 15 });
    console.log(`${w.name}: USDC associated ${hashscan.tx(associateTxId)}`);
  }

  return {
    accountId,
    evmAddress,
    hashscan: hashscan.account(accountId),
    worker: { name: w.worker, accountId: required(`${w.worker}_ID`) },
    keyList: {
      description: `KeyList([${w.worker}, COSIGNER], threshold 2), no EVM alias`,
      threshold: decoded.threshold,
      keys: [
        { role: "worker", ...decoded.keys[0]! },
        { role: "cosigner", ...decoded.keys[1]! },
      ],
      mirrorKey,
    },
    initialHbar: INITIAL_HBAR,
    maxAutomaticTokenAssociations: 10,
    createTx: link(createTxId),
    usdcAssociateTx: link(associateTxId),
  };
}

function appendEvidence(state: State): void {
  const evidence = readFileSync(EVIDENCE_PATH, "utf8");
  if (evidence.includes(EVIDENCE_HEADING)) {
    console.log("EVIDENCE.md already has the C5 spend wallets section");
    return;
  }
  const rows = WALLETS.map((w) => {
    const r = state.wallets[w.name]!;
    return `| ${w.name} | [${r.accountId}](${r.hashscan}) | \`${r.evmAddress}\` | ${w.worker} ${r.worker.accountId} + COSIGNER ${state.cosigner.accountId} | [${r.createTx.transactionId}](${r.createTx.hashscan}) | [${r.usdcAssociateTx.transactionId}](${r.usdcAssociateTx.hashscan}) |`;
  });
  const keys = WALLETS.flatMap((w) => {
    const r = state.wallets[w.name]!;
    return [
      `${w.name} \`GET /api/v1/accounts/${r.accountId}\` → \`key\`:`,
      "",
      "```json",
      JSON.stringify(r.keyList.mirrorKey),
      "```",
      "",
      `Decoded (protobuf \`Key.thresholdKey\`): threshold ${r.keyList.threshold}, keys ${r.keyList.keys.map((k) => `${k.role} ${k.type} \`${k.publicKey}\``).join(", ")}.`,
      "",
    ];
  });
  const section = [
    "",
    EVIDENCE_HEADING,
    "",
    `Produced by \`scripts/c5-spend-wallets.ts\` on ${new Date().toISOString().slice(0, 10)}; record in \`deployments/testnet/spend-wallets.json\`. Each worker agent spends from its own wallet whose key is \`KeyList([worker, cosigner], 2)\` set with \`setKeyWithoutAlias\` (so its EVM address is the long-zero form of the account id), funded with ${INITIAL_HBAR} HBAR by the operator, \`maxAutomaticTokenAssociations\` 10. USDC [${env.USDC_TOKEN_ID}](${hashscan.token(env.USDC_TOKEN_ID)}) was associated by a \`TokenAssociateTransaction\` signed by both the worker and the policy co-signer.`,
    "",
    "| Wallet | Account | EVM (long-zero) | Keys (2 of 2) | Create tx | USDC association tx |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "The mirror node reports a threshold key as `ProtobufEncoded` (hex of the protobuf `Key`): `2a` = field 5 `thresholdKey`, `08 02` = threshold 2, `12` = its `KeyList`, each entry `0a 23 3a 21 <33-byte compressed secp256k1 key>` (field 7 `ECDSA_secp256k1`). `packages/hedera/src/spendWallet.test.ts` (live) asserts this decodes to threshold 2 over the worker's and co-signer's keys.",
    "",
    ...keys,
    "Facility allowance: not granted yet. The `CreditFacility` is not deployed at this checkpoint, so the standing USDC allowance from each wallet to the facility contract (`AccountAllowanceApproveTransaction.approveTokenAllowance(USDC, wallet, facilityContractId, units)`, signed by worker and co-signer, `units` < 2^63) is granted in C5 spend (Task 5.3) by `approveFacilityAllowance`.",
    "",
  ].join("\n");
  appendFileSync(EVIDENCE_PATH, evidence.endsWith("\n") ? section : `\n${section}`);
  console.log("EVIDENCE.md: appended the C5 spend wallets section");
}

const state = readState();
try {
  for (const w of WALLETS) {
    state.wallets[w.name] = await ensureWallet(state, w);
    writeState(state);
  }
  appendEvidence(state);
} finally {
  client.close();
}
