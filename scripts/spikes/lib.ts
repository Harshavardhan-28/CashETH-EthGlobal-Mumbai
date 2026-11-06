/**
 * Shared helpers for the testnet spike scripts (S2 onwards): forge deploys through the Hashio relay,
 * contract writes with a receipt check, mirror-node lookups and JSON records.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evmClients, mirror } from "@casheth/hedera";
import { loadEnv } from "@casheth/shared";
import { getAddress, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CONTRACTS_DIR = `${ROOT}contracts`;

export const env = loadEnv();
export const operator = evmClients(env, env.HEDERA_OPERATOR_KEY as Hex);
export const pub: PublicClient = operator.public;
export const wallet: WalletClient = operator.wallet!;

export interface TxRecord {
  label?: string;
  hash: Hex;
  transactionId: string;
  hashscan: string;
}

export interface Gas {
  limit: number;
  used: number;
  consumed: number;
}

export interface Deployed {
  address: Address;
  contractId: string;
  tx: TxRecord;
  gas: Gas;
}

/** Mirror REST GET under `/api/v1`; undefined on 404 so it composes with `mirror.waitFor`. */
export async function mirrorGet<T>(path: string): Promise<T | undefined> {
  const base = env.HEDERA_MIRROR_NODE_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const res = await fetch(`${base}/api/v1${path}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`mirror ${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface ContractResult {
  result: string;
  error_message?: string | null;
  gas_limit: number;
  gas_used: number;
  gas_consumed: number;
}

/** Gas limit, gas charged (`gas_used`) and gas actually consumed, from the mirror node. */
export async function gasOf(hash: Hex): Promise<Gas> {
  const r = await mirror.waitFor(() => mirrorGet<ContractResult>(`/contracts/results/${hash}`));
  return { limit: r.gas_limit, used: r.gas_used, consumed: r.gas_consumed };
}

export async function txRecord(hash: Hex, label?: string): Promise<TxRecord> {
  const { transactionId, hashscanUrl } = await mirror.waitFor(() => mirror.txByHash(env, hash));
  return { ...(label ? { label } : {}), hash, transactionId, hashscan: hashscanUrl };
}

/**
 * Contract write from the operator with gas = 1.3x the relay estimate (Hedera charges at least 80%
 * of the limit). Waits for the receipt and fails loudly with the mirror-node reason.
 */
export async function send(
  label: string,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<TxRecord & { gas: Gas }> {
  const estimate = await pub.estimateContractGas({ ...request, account: wallet.account! } as Parameters<
    typeof pub.estimateContractGas
  >[0]);
  const hash = await wallet.writeContract({
    ...request,
    gas: (estimate * 13n) / 10n,
    account: wallet.account!,
    chain: operator.chain,
  } as Parameters<WalletClient["writeContract"]>[0]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const r = await mirror
      .waitFor(() => mirrorGet<ContractResult>(`/contracts/results/${hash}`))
      .catch(() => undefined);
    throw new Error(`${label} reverted (${hash}): ${r?.result ?? "?"} ${r?.error_message ?? ""}`);
  }
  const record = { ...(await txRecord(hash, label)), gas: await gasOf(hash) };
  console.log(`  ${label}: ${record.hashscan} (gas used ${record.gas.used}, consumed ${record.gas.consumed})`);
  return record;
}

/**
 * Runs `contracts/script/<script>` through the relay (the S1 deploy path) and returns the created
 * contracts by name. `--skip-simulation`: forge's replay cannot execute HTS/HSS system contracts.
 */
export async function forgeDeploy(script: string, extraEnv: Record<string, string> = {}): Promise<Map<string, Deployed>> {
  execFileSync(
    process.env.FORGE ?? "forge",
    [
      "script",
      `script/${script}`,
      "--rpc-url",
      env.HEDERA_JSON_RPC_URL,
      "--private-key",
      env.HEDERA_OPERATOR_KEY,
      "--broadcast",
      "--legacy",
      "--slow",
      "--skip-simulation",
      "--gas-estimate-multiplier",
      "130",
    ],
    { cwd: CONTRACTS_DIR, stdio: "inherit", env: { ...process.env, ...extraEnv } },
  );
  const broadcast = JSON.parse(readFileSync(`${CONTRACTS_DIR}/broadcast/${script}/296/run-latest.json`, "utf8")) as {
    transactions: { contractName: string }[];
    receipts: { status: string; contractAddress: Address; transactionHash: Hex }[];
  };
  const byName = new Map<string, Deployed>();
  for (const [i, t] of broadcast.transactions.entries()) {
    const receipt = broadcast.receipts[i];
    if (!receipt || receipt.status !== "0x1") throw new Error(`${t.contractName} creation did not succeed`);
    const address = getAddress(receipt.contractAddress);
    const info = await mirror.waitFor(() => mirrorGet<{ contract_id: string }>(`/contracts/${address}`));
    byName.set(t.contractName, {
      address,
      contractId: info.contract_id,
      tx: await txRecord(receipt.transactionHash),
      gas: await gasOf(receipt.transactionHash),
    });
  }
  return byName;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
