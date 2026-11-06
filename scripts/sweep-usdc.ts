/**
 * Moves all USDC held by the demo accounts in `.env.accounts` (and the S3 spike spend wallet, which
 * is 2-of-2 WORKER_RESEARCH + COSIGNER) back to the operator. A failure on one account is logged
 * and the sweep continues; a summary is printed at the end.
 *
 *   pnpm -r build && pnpm tsx scripts/sweep-usdc.ts
 */
import { hieroClient, mirror, transferUsdc } from "@casheth/hedera";
import { DEMO_ACCOUNTS, hashscan, loadEnv } from "@casheth/shared";

const env = loadEnv();
const client = hieroClient(env);

interface Target {
  label: string;
  id: string;
  keys: string[];
}
const targets: Target[] = [];
for (const prefix of DEMO_ACCOUNTS) {
  const id = env[`${prefix}_ID`];
  const key = env[`${prefix}_KEY`];
  if (id && key) targets.push({ label: prefix, id, keys: [key] });
}
const spendWallet = env["SPIKE_SPEND_WALLET_ID"];
if (typeof spendWallet === "string" && env.WORKER_RESEARCH_KEY && env.COSIGNER_KEY) {
  targets.push({
    label: "SPIKE_SPEND_WALLET",
    id: spendWallet,
    keys: [env.WORKER_RESEARCH_KEY, env.COSIGNER_KEY],
  });
}

const swept: string[] = [];
const failed: string[] = [];
for (const t of targets) {
  try {
    const units = await mirror.tokenBalance(env, t.id, env.USDC_TOKEN_ID);
    if (units === 0n) {
      console.log(`${t.label}: no USDC`);
      continue;
    }
    const txId = await transferUsdc(client, {
      tokenId: env.USDC_TOKEN_ID,
      from: t.id,
      fromKey: t.keys,
      to: env.HEDERA_OPERATOR_ID,
      units,
    });
    swept.push(`${t.label} ${units}`);
    console.log(`${t.label}: swept ${units} USDC units to ${env.HEDERA_OPERATOR_ID} ${hashscan.tx(txId)}`);
  } catch (error) {
    failed.push(t.label);
    console.error(`${t.label}: sweep FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\nSummary: swept ${swept.length} (${swept.join(", ") || "none"}), failed ${failed.length} (${failed.join(", ") || "none"})`);
client.close();
if (failed.length > 0) process.exitCode = 1;
