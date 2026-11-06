/**
 * C4 (Task 4.4L): every demo lender ships a credit strategy and (A, B, C) a base-yield strategy to Aqua on
 * Hedera testnet, from one wallet each.
 *
 *   pnpm -r build && pnpm tsx scripts/c4-ship-strategies.ts      (after scripts/c4-register.ts)
 *
 * | Lender | tier   | sellerSet     | credit USDC | base USDC + tUSDT |
 * | A      | low    | seller        | 3.5         | 0.5 + 0.5         |
 * | B      | medium | seller        | 1.5         | 0.5 + 0.5         |
 * | C      | high   | (any seller)  | 0.5         | 0.5 + 0.5         |
 * | D      | low    | workerResearch| 1           | none              |
 *
 * Sized to the lenders' real USDC (credit + base never exceeds a wallet), so base-yield swaps can draw on it.
 * Each record also carries the full `order`, which the trader agent rebuilds and hash-checks.
 *
 * Salts are 1 (credit) and 2 (base), the base fee is 30 bps, `maxPerBuyer` 5 USDC, `minReserve` 0. Each
 * `Shipped` tx and strategy hash is written to `deployments/testnet/strategies.json`. A strategy whose hash is
 * already open on Aqua is skipped, so a re-run only reads. The run ends by discovering the open strategies
 * and checking their order, virtual balances and exact allowances.
 */
import { existsSync } from "node:fs";
import {
  BASE_FEE_BPS,
  buildBaseYieldOrder,
  buildLenderOrder,
  listOpenStrategies,
  shipBaseYield,
  shipLenderStrategy,
  tierArgs,
  type LenderStrategy,
  type LenderWallet,
  type ShippedStrategy,
  type Tier,
} from "@casheth/aqua";
import { erc20Abi, keccak256, type Address, type Hex } from "viem";
import { LENDER_NAMES, accountEvm, loadDeployment, walletFor, type LenderName } from "./lib/c4.js";
import { pub, readJson, ROOT, txRecord, writeJson, type TxRecord } from "./spikes/lib.js";

const STRATEGIES_FILE = `${ROOT}deployments/testnet/strategies.json`;
const USD = (units: number) => BigInt(Math.round(units * 1_000_000));
const CREDIT_SALT = 1n;
const BASE_SALT = 2n;
const MAX_PER_BUYER = USD(5);
const MIN_RESERVE = 0n;

type LenderPlan = { tier: Tier; sellerSet: Address[]; credit: bigint; base?: bigint };

const seller = accountEvm("SELLER");
const worker = accountEvm("WORKER_RESEARCH");
const LENDERS: Record<LenderName, LenderPlan> = {
  A: { tier: "low", sellerSet: [seller], credit: USD(3.5), base: USD(0.5) },
  B: { tier: "medium", sellerSet: [seller], credit: USD(1.5), base: USD(0.5) },
  C: { tier: "high", sellerSet: [], credit: USD(0.5), base: USD(0.5) },
  D: { tier: "low", sellerSet: [worker], credit: USD(1) },
};

type StrategyRecord = {
  lender: LenderName;
  kind: "credit" | "base";
  maker: Address;
  salt: string;
  /** USDC and (base only) tUSDT shipped, 6 decimals. */
  usdc: string;
  tUsdt?: string;
  strategyHash: Hex;
  /** `ISwapVM.Order`; `traits` as a decimal string. */
  order: { maker: Address; traits: string; data: Hex };
  tx: TxRecord;
};
type StrategiesFile = { network: "testnet"; chainId: 296; strategies: StrategyRecord[] };

const { aqua, fromBlock } = loadDeployment();

/** One strategy to ship: its hash is known before shipping so a re-run can tell it is already open. */
type Shipment = {
  kind: StrategyRecord["kind"];
  salt: bigint;
  usdc: bigint;
  tUsdt?: bigint;
  hash: () => Promise<Hex>;
  ship: () => Promise<ShippedStrategy>;
};

function shipmentsOf(wallet: LenderWallet, plan: LenderPlan): Shipment[] {
  const maker = wallet.account.address;
  const args = tierArgs(plan.tier, { sellerSet: plan.sellerSet, maxPerBuyer: MAX_PER_BUYER, minReserve: MIN_RESERVE });
  const credit: Shipment = {
    kind: "credit",
    salt: CREDIT_SALT,
    usdc: plan.credit,
    hash: async () =>
      keccak256((await buildLenderOrder(pub, aqua.orderBuilder, { maker, rcn: aqua.rcn, usdc: aqua.usdc, args, salt: CREDIT_SALT })).strategy),
    ship: () => shipLenderStrategy(wallet, aqua, { args, salt: CREDIT_SALT, usdcAmount: plan.credit }),
  };
  if (plan.base === undefined) return [credit];
  const base = plan.base;
  return [
    credit,
    {
      kind: "base",
      salt: BASE_SALT,
      usdc: base,
      tUsdt: base,
      hash: async () =>
        keccak256(
          (await buildBaseYieldOrder(pub, aqua.orderBuilder, { maker, usdc: aqua.usdc, tUsdt: aqua.tUsdt, feeBps: BASE_FEE_BPS, salt: BASE_SALT })).strategy,
        ),
      ship: () => shipBaseYield(wallet, aqua, { usdcAmount: base, tUsdtAmount: base, feeBps: BASE_FEE_BPS, salt: BASE_SALT }),
    },
  ];
}

function readStrategies(): StrategiesFile {
  return existsSync(STRATEGIES_FILE) ? readJson<StrategiesFile>(STRATEGIES_FILE) : { network: "testnet", chainId: 296, strategies: [] };
}

async function shipOnce(file: StrategiesFile, open: Set<Hex>, lender: LenderName, maker: Address, s: Shipment): Promise<void> {
  const label = `${lender} ${s.kind}`;
  const expected = await s.hash();
  if (open.has(expected)) {
    if (!file.strategies.some((r) => r.strategyHash === expected)) {
      throw new Error(`${label} (${expected}) is open on Aqua but strategies.json has no record of its Shipped tx`);
    }
    console.log(`  ${label}: already open ${expected}`);
    return;
  }
  const { strategyHash, txHash, order } = await s.ship();
  if (strategyHash !== expected) throw new Error(`${label}: shipped ${strategyHash}, expected ${expected}`);
  const tx = await txRecord(txHash, `Aqua.ship(${label})`);
  file.strategies.push({
    lender,
    kind: s.kind,
    maker,
    salt: s.salt.toString(),
    usdc: s.usdc.toString(),
    ...(s.tUsdt === undefined ? {} : { tUsdt: s.tUsdt.toString() }),
    strategyHash,
    order: { maker: order.maker, traits: order.traits.toString(), data: order.data },
    tx,
  });
  writeJson(STRATEGIES_FILE, file);
  console.log(`  ${label}: ${strategyHash} ${tx.hashscan}`);
}

async function allowanceToAqua(token: Address, owner: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, aqua.aqua] });
}

/** Discovery returns exactly the seven strategies, cheapest credit first, with the shipped balances and exact allowances. */
async function verify(file: StrategiesFile): Promise<LenderStrategy[]> {
  const found = await listOpenStrategies(pub, aqua, { fromBlock });
  const byHash = new Map(file.strategies.map((r) => [r.strategyHash, r]));
  const seen = found.map((s) => {
    const r = byHash.get(s.strategyHash);
    if (!r) throw new Error(`open strategy ${s.strategyHash} of ${s.maker} is not in strategies.json`);
    return `${s.kind}:${r.lender}`;
  });
  const want = ["credit:A", "credit:D", "credit:B", "credit:C", "base:A", "base:B", "base:C"];
  if (seen.length !== file.strategies.length || seen.join() !== want.join()) {
    throw new Error(`discovery order ${seen.join(" ")}, expected ${want.join(" ")}`);
  }
  for (const s of found) {
    const r = byHash.get(s.strategyHash)!;
    const plan = LENDERS[r.lender];
    if (s.virtual[aqua.usdc] !== BigInt(r.usdc)) throw new Error(`${r.lender} ${r.kind}: virtual USDC ${s.virtual[aqua.usdc]}`);
    if (s.allowance !== plan.credit + (plan.base ?? 0n)) throw new Error(`${r.lender}: USDC allowance ${s.allowance} is not exact`);
    if (r.kind === "base" && (await allowanceToAqua(aqua.tUsdt, s.maker)) !== plan.base) throw new Error(`${r.lender}: tUSDT allowance is not exact`);
  }
  return found;
}

const file = readStrategies();
const open = new Set((await listOpenStrategies(pub, aqua, { fromBlock })).map((s) => s.strategyHash));
for (const lender of LENDER_NAMES) {
  console.log(`lender ${lender}`);
  const wallet = walletFor(`LENDER_${lender}`);
  for (const shipment of shipmentsOf(wallet, LENDERS[lender])) {
    await shipOnce(file, open, lender, wallet.account.address, shipment);
  }
}

console.log("verify: discovery from the Aqua deployment block");
const found = await verify(file);
for (const s of found) {
  const r = file.strategies.find((x) => x.strategyHash === s.strategyHash)!;
  console.log(`  ${r.kind} ${r.lender} ${s.args ? `${s.args.aprBps} bps` : `fee ${s.feeBps} bps`} ${r.tx.hashscan}`);
}
