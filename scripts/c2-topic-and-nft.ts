/**
 * Checkpoint C2 (Hedera-native half): creates the HCS audit topic and the receivable NFT
 * collection, builds an HCS-14 UAID for each of the ten demo agents and publishes an
 * `AgentRegistered` profile for each to the topic. No NFT is minted here (the first mint needs a
 * registered receivable and happens in Task 4.3).
 *
 * Idempotent: ids already in deployments/testnet/hedera.json are reused, and an agent whose UAID
 * already has an `AgentRegistered` message on the topic is not published again.
 *
 *   pnpm -r build && pnpm tsx scripts/c2-topic-and-nft.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUaid,
  createAuditTopic,
  createReceivableCollection,
  hieroClient,
  mirror,
  publishProfile,
  readAuditMessages,
  type AgentRole,
} from "@casheth/hedera";
import { DEMO_ACCOUNTS, HEDERA_IDS_PATH, hashscan, loadEnv, loadHederaIds, type DemoAccount } from "@casheth/shared";

const ENV_ACCOUNTS_PATH = fileURLToPath(new URL("../.env.accounts", import.meta.url));
const EVIDENCE_PATH = fileURLToPath(new URL("../docs/EVIDENCE.md", import.meta.url));
const EVIDENCE_HEADING = "## C2: HCS topic, HCS-14 profiles and receivable NFT collection";

const AGENTS: Record<DemoAccount, { name: string; role: AgentRole }> = {
  SELLER: { name: "CashETH Seller", role: "seller" },
  BUYER: { name: "CashETH Buyer", role: "buyer" },
  WORKER_RESEARCH: { name: "CashETH Research Worker", role: "worker" },
  WORKER_COMPUTE: { name: "CashETH Compute Worker", role: "worker" },
  LENDER_A: { name: "CashETH Lender A", role: "lender" },
  LENDER_B: { name: "CashETH Lender B", role: "lender" },
  LENDER_C: { name: "CashETH Lender C", role: "lender" },
  COORDINATOR: { name: "CashETH Coordinator", role: "coordinator" },
  COSIGNER: { name: "CashETH Co-signer", role: "cosigner" },
  KYA_ISSUER: { name: "CashETH KYA Issuer", role: "issuer" },
};

interface PartialIds {
  network: "testnet";
  hcsAuditTopicId?: string;
  receivableNftTokenId?: string;
  createdAt?: string;
}

const env = loadEnv();
const client = hieroClient(env);

function readIds(): PartialIds {
  if (!existsSync(HEDERA_IDS_PATH)) return { network: "testnet" };
  return JSON.parse(readFileSync(HEDERA_IDS_PATH, "utf8")) as PartialIds;
}

function writeIds(ids: PartialIds): void {
  mkdirSync(dirname(HEDERA_IDS_PATH), { recursive: true });
  const ordered = {
    network: ids.network,
    hcsAuditTopicId: ids.hcsAuditTopicId,
    receivableNftTokenId: ids.receivableNftTokenId,
    createdAt: ids.createdAt ?? new Date().toISOString(),
  };
  writeFileSync(HEDERA_IDS_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
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
    else if (had !== value) console.warn(`.env.accounts already has ${key} with a different value; left as is`);
  }
  if (lines.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(ENV_ACCOUNTS_PATH, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
}

// 1. Topic and collection, saved after each creation so a crash never loses an id.
const ids = readIds();
if (ids.hcsAuditTopicId) {
  console.log(`topic: exists ${ids.hcsAuditTopicId}`);
} else {
  const { topicId, txId } = await createAuditTopic(client);
  ids.hcsAuditTopicId = topicId;
  writeIds(ids);
  console.log(`topic: created ${topicId} ${hashscan.tx(txId)}`);
}
if (ids.receivableNftTokenId) {
  console.log(`collection: exists ${ids.receivableNftTokenId}`);
} else {
  const { tokenId, txId } = await createReceivableCollection(client, {
    name: "CashETH Receivable",
    symbol: "CRCV",
  });
  ids.receivableNftTokenId = tokenId;
  writeIds(ids);
  console.log(`collection: created ${tokenId} ${hashscan.tx(txId)}`);
}
const { hcsAuditTopicId: topicId, receivableNftTokenId: tokenId } = loadHederaIds();
console.log(`topic ${hashscan.topic(topicId)}\ncollection ${hashscan.token(tokenId)}`);

// 2. Agent profiles. Existing AgentRegistered messages are read first so a re-run publishes none twice.
const existing = await mirror.waitFor(() => readAuditMessages(env, topicId, { limit: 100 }), {
  attempts: 15,
  delayMs: 2000,
});
const registered = new Map<string, { seq: number; link: string }>();
for (const m of existing) {
  if (m.message.type === "AgentRegistered" && m.message.agentUaid && !m.message.test) {
    registered.set(m.message.agentUaid, {
      seq: m.sequenceNumber,
      link: hashscan.tx(m.txId ?? m.consensusTimestamp),
    });
  }
}
let lastSeq = existing.at(-1)?.sequenceNumber ?? 0;

const rows: { label: DemoAccount; accountId: string; uaid: string; seq: number; link: string }[] = [];
for (const label of DEMO_ACCOUNTS) {
  const accountId = env[`${label}_ID`];
  const evm = env[`${label}_EVM`];
  if (!accountId || !evm) throw new Error(`${label}_ID/${label}_EVM missing; run pnpm setup:accounts first`);
  const { uaid, profile } = await buildUaid({
    evmAddress: evm as `0x${string}`,
    accountId,
    ...AGENTS[label],
    network: "hedera:testnet",
  });
  const prior = registered.get(uaid);
  if (prior) {
    rows.push({ label, accountId, uaid, ...prior });
    console.log(`${label}: already registered at seq ${prior.seq}`);
    continue;
  }
  const { sequenceNumber, txId } = await publishProfile(client, topicId, profile, lastSeq);
  lastSeq = sequenceNumber;
  rows.push({ label, accountId, uaid, seq: sequenceNumber, link: hashscan.tx(txId) });
  console.log(`${label}: AgentRegistered seq ${sequenceNumber} ${hashscan.tx(txId)}`);
}

// 3. Local env (gitignored) for later scripts.
appendEnvAccounts([
  ["HCS_AUDIT_TOPIC_ID", topicId],
  ["RECEIVABLE_NFT_TOKEN_ID", tokenId],
  ...rows.map((r): [string, string] => [`${r.label}_UAID`, r.uaid]),
]);

// 4. Evidence, appended once.
const evidence = readFileSync(EVIDENCE_PATH, "utf8");
if (evidence.includes(EVIDENCE_HEADING)) {
  console.log("EVIDENCE.md already has the C2 HCS section");
} else {
  const table = rows
    .map((r) => `| ${AGENTS[r.label].name} | ${r.accountId} | \`${r.uaid}\` | [${r.seq}](${r.link}) |`)
    .join("\n");
  const section = [
    "",
    EVIDENCE_HEADING,
    "",
    `Produced by \`scripts/c2-topic-and-nft.ts\` on ${new Date().toISOString().slice(0, 10)}. Ids are in \`deployments/testnet/hedera.json\`.`,
    "",
    `- HCS audit topic: [${topicId}](${hashscan.topic(topicId)}) (memo \`CashETH audit v1\`, submit key = operator, so only the orchestrator can write)`,
    `- Receivable NFT collection: [${tokenId}](${hashscan.token(tokenId)}) (\`CashETH Receivable\` / \`CRCV\`, non-fungible, infinite supply, treasury and supply key = operator). No serial is minted yet; the first mint follows the on-chain receivable registration in Task 4.3.`,
    "",
    "Each agent's UAID comes from the standards SDK's HCS-14 AID generator (`createUaid` in `@hashgraphonline/standards-sdk@0.1.192`): SHA-384 over the canonical agent data (registry `casheth`, name, version `1`, protocol `mcp`, nativeId = CAIP-10 Hedera account, no skills), base58-encoded, with `uid`, `registry`, `proto` and `nativeId` routing params. Each profile is published as an `AgentRegistered` audit message; the sequence number links to its transaction.",
    "",
    "| Agent | Account | UAID | HCS seq |",
    "| --- | --- | --- | --- |",
    table,
    "",
  ].join("\n");
  appendFileSync(EVIDENCE_PATH, evidence.endsWith("\n") ? section : `\n${section}`);
  console.log("EVIDENCE.md: appended the C2 HCS section");
}
client.close();
