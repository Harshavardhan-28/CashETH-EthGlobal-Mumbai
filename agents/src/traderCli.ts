/**
 * `pnpm -F @casheth/agents trader`: runs the scripted volume against every base-yield strategy in
 * `deployments/testnet/strategies.json` from the operator's wallet, and writes the swaps (with HashScan links) to
 * `deployments/testnet/trades.json`. Addresses are read at run time from `deployments/testnet/addresses.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmClients } from "@casheth/hedera";
import { loadAddresses, loadEnv } from "@casheth/shared";
import type { Hex } from "viem";
import { baseStrategies, collectTrades, serializeTrades, TradeError } from "./trader.js";
import { createTraderChain, type TraderChainClients } from "./traderChain.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const STRATEGIES_FILE = `${root}deployments/testnet/strategies.json`;
const TRADES_FILE = `${root}deployments/testnet/trades.json`;

function required<T>(name: string, value: T | undefined): T {
  if (value === undefined) throw new Error(`addresses.json has no ${name}: deploy the core contracts first`);
  return value;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const addresses = loadAddresses();
  const deployment = {
    orderBuilder: required("orderBuilder", addresses.orderBuilder),
    swapRouter: required("swapRouter", addresses.swapRouter),
    taker: required("taker", addresses.taker),
    usdc: required("usdc", addresses.usdc),
    tUsdt: required("tUsdt", addresses.tUsdt),
  };
  const { public: reader, wallet } = evmClients(env, env.HEDERA_OPERATOR_KEY as Hex);
  if (!wallet?.account || !wallet.chain) throw new Error("no operator wallet: set HEDERA_OPERATOR_KEY");
  const chain = createTraderChain({ public: reader, wallet } as TraderChainClients, deployment);
  const strategies = baseStrategies(JSON.parse(readFileSync(STRATEGIES_FILE, "utf8")));

  // Confirmed swaps are written even when the run stops on a failed leg: their fee income is already on chain.
  const { records, failure } = await collectTrades({ chain, strategies, tokens: { usdc: deployment.usdc, tUsdt: deployment.tUsdt } });
  writeFileSync(TRADES_FILE, `${JSON.stringify(serializeTrades(records, failure instanceof TradeError ? failure : undefined), null, 2)}\n`);
  console.log(`${records.length} swaps written to deployments/testnet/trades.json`);
  if (failure) throw failure;
}

process.exitCode = await main().then(
  () => 0,
  (error: unknown) => {
    console.error(error instanceof TradeError ? `FILL FAILED: ${error.message}` : error);
    return 1;
  },
);
process.exit();
