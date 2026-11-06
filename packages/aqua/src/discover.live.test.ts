/**
 * Discovery against the strategies shipped to Hedera testnet by scripts/c4-ship-strategies.ts.
 * Runs only with `LIVE=1` (needs `.env` and `deployments/testnet/strategies.json`):
 *
 *   LIVE=1 pnpm -F @casheth/aqua exec vitest run --project unit discover.live
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAddresses, loadEnv } from "@casheth/shared";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { listOpenStrategies } from "./discover.js";

const STRATEGIES = fileURLToPath(new URL("../../../deployments/testnet/strategies.json", import.meta.url));

type Recorded = { lender: string; kind: "credit" | "base"; maker: Address; strategyHash: Hex; usdc: string };

describe.skipIf(!process.env.LIVE)("listOpenStrategies on Hedera testnet", () => {
  it("returns credit A, D, B, C (apr ascending, ties in shipping order) then base A, B, C", async () => {
    const env = loadEnv();
    const addresses = loadAddresses();
    const addrs = {
      aqua: addresses.aqua!,
      swapRouter: addresses.swapRouter!,
      orderBuilder: addresses.orderBuilder!,
      rcn: addresses.rcn!,
      tUsdt: addresses.tUsdt!,
      usdc: getAddress(env.USDC_EVM_ADDRESS),
    };
    const client = createPublicClient({ transport: http(env.HEDERA_JSON_RPC_URL, { timeout: 60_000, retryCount: 5, retryDelay: 1_000 }) });
    const recorded: Recorded[] = JSON.parse(readFileSync(STRATEGIES, "utf8")).strategies;
    const name = new Map(recorded.map((r) => [r.strategyHash, `${r.kind}:${r.lender}`]));

    const found = await listOpenStrategies(client, addrs, { fromBlock: BigInt(addresses.deployedBlock!) });

    expect(found.map((s) => name.get(s.strategyHash) ?? s.strategyHash)).toEqual([
      "credit:A",
      "credit:D",
      "credit:B",
      "credit:C",
      "base:A",
      "base:B",
      "base:C",
    ]);
    expect(found.map((s) => s.args?.aprBps ?? s.feeBps)).toEqual([700, 700, 850, 1300, 30, 30, 30]);
    for (const s of found) expect(s.maker).toBe(getAddress(recorded.find((r) => r.strategyHash === s.strategyHash)!.maker));
  }, 300_000);
});
