/** What the agent CLIs read about a demo account besides its `.env.accounts` entry. */
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";

const repoFile = (path: string) => new URL(`../../${path}`, import.meta.url);

/** `WORKER_RESEARCH` -> the mandate hash `scripts/c2-register-demo.ts` registered for `workerResearch`. */
export function mandateHashFor(account: string): Hex {
  const label = account.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return keccak256(toHex(`mandate-v1-${label}`));
}

/** Long-zero EVM address of the worker's 2-of-2 spend wallet, from `deployments/testnet/spend-wallets.json`. */
export function spendWalletOf(account: string): Address {
  const { wallets } = JSON.parse(readFileSync(repoFile("deployments/testnet/spend-wallets.json"), "utf8")) as {
    wallets: Record<string, { evmAddress: Address; worker: { name: string } }>;
  };
  const wallet = Object.values(wallets).find((w) => w.worker.name === account);
  if (!wallet) throw new Error(`no spend wallet registered for ${account} in deployments/testnet/spend-wallets.json`);
  return wallet.evmAddress;
}
