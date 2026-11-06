/**
 * Moves all USDC held by the demo accounts in `.env.accounts` back to the operator.
 *
 *   pnpm -r build && pnpm tsx scripts/sweep-usdc.ts
 */
import { hieroClient, mirror, transferUsdc } from "@casheth/hedera";
import { DEMO_ACCOUNTS, hashscan, loadEnv } from "@casheth/shared";

const env = loadEnv();
const client = hieroClient(env);

for (const prefix of DEMO_ACCOUNTS) {
  const id = env[`${prefix}_ID`];
  const key = env[`${prefix}_KEY`];
  if (!id || !key) continue;
  const units = await mirror.tokenBalance(env, id, env.USDC_TOKEN_ID);
  if (units === 0n) {
    console.log(`${prefix}: no USDC`);
    continue;
  }
  const txId = await transferUsdc(client, {
    tokenId: env.USDC_TOKEN_ID,
    from: id,
    fromKey: key,
    to: env.HEDERA_OPERATOR_ID,
    units,
  });
  console.log(
    `${prefix}: swept ${units} USDC units to ${env.HEDERA_OPERATOR_ID} ${hashscan.tx(txId)}`,
  );
}
client.close();
