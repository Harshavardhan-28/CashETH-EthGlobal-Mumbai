/**
 * C5 spend, step 0: the standing USDC allowance from each spend wallet to the CreditFacility, granted with
 * `approveFacilityAllowance` (an `AccountAllowanceApproveTransaction` signed by the worker and the co-signer).
 * `release` pulls an unspent reservation back through it. The amount is exact (HTS allowances are int64, "max"
 * reverts) and the grant is skipped for a wallet whose allowance already covers it, so a re-run only reads.
 *
 *   pnpm -r build && pnpm tsx scripts/c5-allowance.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { approveFacilityAllowance, hieroClient, mirror, PrivateKey, resolveContractId } from "@casheth/hedera";
import { hashscan, loadAddresses } from "@casheth/shared";
import { erc20Abi, type Address } from "viem";
import { env, mirrorGet, pub, ROOT } from "./spikes/lib.js";

const STATE_PATH = `${ROOT}deployments/testnet/spend-wallets.json`;
const UNITS = 1_000_000_000n;
const WALLETS = [
  { name: "SPEND_WALLET_RESEARCH", worker: "WORKER_RESEARCH" },
  { name: "SPEND_WALLET_COMPUTE", worker: "WORKER_COMPUTE" },
] as const;

type Allowance = { transactionId: string; hashscan: string; spender: string; units: string };
const vars = env as unknown as Record<string, string | undefined>;
const required = (name: string): string => {
  const value = vars[name];
  if (!value) throw new Error(`${name} missing from .env.accounts`);
  return value;
};

/** The wallet's USDC allowance to `spenderId` as the mirror node reports it (0 when none). */
async function mirrorAllowance(walletId: string, spenderId: string): Promise<bigint> {
  const body = await mirrorGet<{ allowances: { token_id: string; amount_granted: number }[] }>(
    `/accounts/${walletId}/allowances/tokens?spender.id=${spenderId}&token.id=${env.USDC_TOKEN_ID}`,
  );
  return BigInt(body?.allowances[0]?.amount_granted ?? 0);
}

const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
  wallets: Record<string, { accountId: string; evmAddress: Address }>;
  facilityAllowance: Record<string, unknown>;
};
const facility = loadAddresses().creditFacility;
if (!facility) throw new Error("addresses.json has no creditFacility");
const facilityId = await resolveContractId(env, facility);
const client = hieroClient(env);
const cosignerKey = PrivateKey.fromStringECDSA(required("COSIGNER_KEY"));
const grants: Record<string, Allowance> = {};
const saved = (state.facilityAllowance.wallets ?? {}) as Record<string, Allowance>;

try {
  for (const w of WALLETS) {
    const wallet = state.wallets[w.name]!;
    const current = await mirrorAllowance(wallet.accountId, facilityId);
    if (current >= UNITS && saved[w.name]?.spender === facilityId) {
      console.log(`${w.name}: allowance ${current} to ${facilityId} already granted`);
      grants[w.name] = saved[w.name]!;
      continue;
    }
    const txId = await approveFacilityAllowance(client, {
      walletId: wallet.accountId,
      tokenId: env.USDC_TOKEN_ID,
      spenderContractId: facilityId,
      units: UNITS,
      keys: [PrivateKey.fromStringECDSA(required(`${w.worker}_KEY`)), cosignerKey],
    });
    console.log(`${w.name}: granted ${UNITS} to ${facilityId} ${hashscan.tx(txId)}`);
    grants[w.name] = { transactionId: txId, hashscan: hashscan.tx(txId), spender: facilityId, units: UNITS.toString() };
  }

  // Verify through the mirror node and through the token's ERC-20 facade (what `release` uses).
  const verified: Record<string, { mirror: string; erc20: string }> = {};
  for (const w of WALLETS) {
    const wallet = state.wallets[w.name]!;
    const viaMirror = await mirror.waitFor(async () => {
      const v = await mirrorAllowance(wallet.accountId, facilityId);
      return v >= UNITS ? v : undefined;
    }, { attempts: 15 });
    const viaErc20 = await pub.readContract({
      address: env.USDC_EVM_ADDRESS as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet.evmAddress, facility],
    });
    if (viaErc20 !== UNITS) throw new Error(`${w.name}: ERC-20 allowance ${viaErc20}, expected ${UNITS}`);
    verified[w.name] = { mirror: viaMirror.toString(), erc20: viaErc20.toString() };
  }

  state.facilityAllowance = {
    status: "granted",
    token: env.USDC_TOKEN_ID,
    spender: { contractId: facilityId, evmAddress: facility },
    units: UNITS.toString(),
    wallets: grants,
    verified,
  };
  writeFileSync(STATE_PATH, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log("spend-wallets.json: facilityAllowance recorded");
} finally {
  client.close();
}
