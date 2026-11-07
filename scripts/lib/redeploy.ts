/**
 * Helpers for redeploying the core stack (scripts/c4-redeploy-prepare.ts): balances, the coordinator's HBAR
 * top-up, docking the replaced strategies and archiving the stack that is replaced.
 */
import { dockStrategy, listOpenStrategies, approveAquaExact, type LenderWallet } from "@casheth/aqua";
import { mirror } from "@casheth/hedera";
import { erc20Abi, parseEther, type Hex } from "viem";
import { LENDER_NAMES, accountEvm, walletFor, type Deployment } from "./c4.js";
import { env, operator, pub, ROOT, txRecord, writeJson, type TxRecord } from "../spikes/lib.js";

export const archiveFile = (name: string): string => `${ROOT}deployments/testnet/archive-${name}.json`;
const TINYBARS_PER_HBAR = 1e8;

const ACCOUNTS = ["HEDERA_OPERATOR", "COORDINATOR", ...LENDER_NAMES.map((n) => `LENDER_${n}` as const), "BUYER", "SELLER"] as const;
export type BalanceRow = { account: string; id: string; hbar: number; usdc: bigint };

/** USDC (base units) and HBAR for the operator, the coordinator, the lenders, the buyer and the seller. */
export async function accountBalances(): Promise<BalanceRow[]> {
  return Promise.all(
    ACCOUNTS.map(async (account) => {
      const id = env[`${account}_ID` as keyof typeof env] as string;
      const { balance } = await mirror.account(env, id);
      return {
        account: account.replace("HEDERA_", ""),
        id,
        hbar: balance.balance / TINYBARS_PER_HBAR,
        usdc: await mirror.tokenBalance(env, id, env.USDC_TOKEN_ID),
      };
    }),
  );
}

export function printBalances(title: string, rows: BalanceRow[]): void {
  console.log(title);
  for (const r of rows) {
    console.log(`  ${r.account.padEnd(12)} ${r.id.padEnd(13)} ${r.hbar.toFixed(4).padStart(10)} HBAR ${(Number(r.usdc) / 1e6).toFixed(6).padStart(10)} USDC`);
  }
}

/** Tops the coordinator up from the operator to at least `minHbar` (a plain value transfer through the relay). */
export async function ensureCoordinatorHbar(rows: BalanceRow[], minHbar: number): Promise<void> {
  const held = rows.find((r) => r.account === "COORDINATOR")!.hbar;
  const operatorHbar = rows.find((r) => r.account === "OPERATOR")!.hbar;
  const shortfall = Math.ceil(minHbar - held);
  if (shortfall <= 0) return;
  if (operatorHbar < shortfall + 50) throw new Error(`BLOCKED: the coordinator needs ${shortfall} more HBAR and the operator holds ${operatorHbar}`);
  const hash = await operator.wallet!.sendTransaction({
    account: operator.wallet!.account!,
    chain: operator.wallet!.chain,
    to: accountEvm("COORDINATOR"),
    value: parseEther(String(shortfall)),
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  coordinator topped up by ${shortfall} HBAR from the operator: ${(await txRecord(hash)).hashscan}`);
}

export type OldStrategy = { lender: (typeof LENDER_NAMES)[number]; kind: "credit" | "base"; strategyHash: Hex };

/** Docks every still-open old strategy (credit: USDC + RCN, base: USDC + tUSDT) and returns the dock transactions. */
export async function dockOldStrategies(old: Deployment, strategies: OldStrategy[]): Promise<TxRecord[]> {
  const open = new Set((await listOpenStrategies(pub, old.aqua, { fromBlock: old.fromBlock })).map((s) => s.strategyHash));
  const txs: TxRecord[] = [];
  for (const s of strategies) {
    const label = `Aqua.dock(${s.lender} ${s.kind})`;
    if (!open.has(s.strategyHash)) {
      console.log(`  ${label}: already docked`);
      continue;
    }
    const tokens = [old.aqua.usdc, s.kind === "credit" ? old.aqua.rcn : old.aqua.tUsdt];
    const { txHash } = await dockStrategy(walletFor(`LENDER_${s.lender}`), old.aqua.aqua, { app: old.aqua.swapRouter, strategyHash: s.strategyHash, tokens });
    const tx = await txRecord(txHash, label);
    console.log(`  ${label}: ${tx.hashscan}`);
    txs.push(tx);
  }
  return txs;
}

/** Sets every lender's USDC and tUSDT allowance to Aqua back to zero, so the new strategies' approvals are exact. */
export async function clearAquaAllowances(old: Deployment): Promise<void> {
  for (const lender of LENDER_NAMES) {
    const wallet: LenderWallet = walletFor(`LENDER_${lender}`);
    for (const token of [old.aqua.usdc, old.aqua.tUsdt]) {
      const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [wallet.account.address, old.aqua.aqua] });
      if (allowance === 0n) continue;
      const hash = await approveAquaExact(wallet, token, old.aqua.aqua, 0n);
      console.log(`  lender ${lender}: allowance ${allowance} -> 0 on ${token} ${(await txRecord(hash)).hashscan}`);
    }
  }
}

export function writeArchive(file: string, archive: Record<string, unknown> & { archivedAt: string; reason: string }): void {
  writeJson(file, archive);
}

