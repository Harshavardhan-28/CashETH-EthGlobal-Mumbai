/** The wallet's live dependencies: Hedera testnet over the JSON-RPC relay (with its retries) and addresses.json. */
import { walletCallSender, type AgentWallet, type CallSender } from "@casheth/agents";
import { evmClients } from "@casheth/hedera";
import { loadAddresses, type Env } from "@casheth/shared";
import { erc20Abi, parseUnits, type Address } from "viem";
import { loadKeyRing, type HeldAccount } from "./accounts.js";
import type { WalletDeps } from "./server.js";

const DEFAULT_APPROVE_CAP_USDC = "20";

/** `WALLET_APPROVE_CAP_USDC` (decimal USDC, default 20): the largest approval one call may carry, in base units. */
export function approveCap(env: Env): bigint {
  const raw = env.WALLET_APPROVE_CAP_USDC;
  const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_APPROVE_CAP_USDC;
  if (!/^\d+(\.\d{1,6})?$/.test(value) || parseUnits(value, 6) === 0n) {
    throw new Error(`WALLET_APPROVE_CAP_USDC must be a positive USDC amount such as 20 or 6.5, not "${value}"`);
  }
  return parseUnits(value, 6);
}

export function liveWalletDeps(env: Env): WalletDeps {
  const { public: chain } = evmClients(env);
  const senders = new Map<string, CallSender>();
  const sender = (held: HeldAccount): CallSender => {
    let send = senders.get(held.info.account);
    if (!send) {
      send = walletCallSender(evmClients(env, held.key).wallet as AgentWallet);
      senders.set(held.info.account, send);
    }
    return send;
  };
  const usdc = (): Address => {
    const address = loadAddresses().usdc;
    if (!address) throw new Error("deployments/testnet/addresses.json has no usdc");
    return address;
  };
  return {
    ring: loadKeyRing(env),
    addresses: () => loadAddresses(),
    approveCap: approveCap(env),
    sender,
    async balances(address) {
      const [hbar, balance] = await Promise.all([
        chain.getBalance({ address }),
        chain.readContract({ address: usdc(), abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      ]);
      return { hbar, usdc: balance };
    },
  };
}
