/**
 * C4 (Task 4.4L): every demo lender ships a credit strategy and (A, B, C) a base-yield strategy to Aqua on
 * Hedera testnet, from one wallet each.
 *
 *   pnpm -r build && pnpm tsx scripts/c4-ship-strategies.ts      (after scripts/c4-register.ts)
 *
 * | Lender | slabs funded      | sellers        | credit USDC | base USDC + tUSDT |
 * | A      | low, medium       | seller         | 3.5         | 0.5 + 0.5         |
 * | B      | medium            | seller         | 1.5         | 0.5 + 0.5         |
 * | C      | high              | (any seller)   | 0.5         | 0.5 + 0.5         |
 * | D      | low, medium, high | workerResearch | 1           | none              |
 *
 * Lenders choose risk, not price: every fill pays the seller's own rate (`RiskPricing.sol`). A new seller scores
 * 600 (medium risk, 11%), so A and B fund it, C is skipped for its slab and D for its seller list.
 *
 * Before a lender ships anything new, the operator tops its wallet up by exactly the shortfall (credit + base minus
 * its USDC), so every strategy is backed by real USDC; each top-up is recorded with its transaction.
 * Each record also carries the full `order`, which the trader agent rebuilds and hash-checks.
 *
 * Salts are 1 (credit) and 2 (base), the base fee is 30 bps, `maxPerBuyer` 5 USDC, `minReserve` 0. Each
 * `Shipped` tx and strategy hash is written to `deployments/testnet/strategies.json`. A strategy whose hash is
 * already open on Aqua is skipped, so a re-run only reads. The run ends by discovering the open strategies
 * and checking their order, virtual balances and exact allowances.
 */
import { existsSync } from "node:fs";
import { hashscan } from "@casheth/shared";
import { hieroClient, transferUsdc } from "@casheth/hedera";
import {
  BASE_FEE_BPS,
  buildBaseYieldOrder,
  buildLenderOrder,
  listOpenStrategies,
  shipBaseYield,
  shipLenderStrategy,
  creditArgs,
  slabsOf,
  type LenderStrategy,
  type LenderWallet,
  type RiskSlab,
  type ShippedStrategy,
} from "@casheth/aqua";
import { erc20Abi, keccak256, type Address, type Hex } from "viem";
import { LENDER_NAMES, accountEvm, loadDeployment, walletFor, type LenderName } from "./lib/c4.js";
import { env, pub, readJson, ROOT, txRecord, writeJson, type TxRecord } from "./spikes/lib.js";

const STRATEGIES_FILE = `${ROOT}deployments/testnet/strategies.json`;
const USD = (units: number) => BigInt(Math.round(units * 1_000_000));
const CREDIT_SALT = 1n;
const BASE_SALT = 2n;
const MAX_PER_BUYER = USD(5);
const MIN_RESERVE = 0n;

type LenderPlan = { slabs: RiskSlab[]; sellerSet: Address[]; credit: bigint; base?: bigint };

const seller = accountEvm("SELLER");
const worker = accountEvm("WORKER_RESEARCH");
const LENDERS: Record<LenderName, LenderPlan> = {
  A: { slabs: ["low", "medium"], sellerSet: [seller], credit: USD(3.5), base: USD(0.5) },
  B: { slabs: ["medium"], sellerSet: [seller], credit: USD(1.5), base: USD(0.5) },
  C: { slabs: ["high"], sellerSet: [], credit: USD(0.5), base: USD(0.5) },
  D: { slabs: ["low", "medium", "high"], sellerSet: [worker], credit: USD(1) },
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
type TopUp = { lender: LenderName; units: string; transactionId: string; hashscan: string };
type StrategiesFile = { network: "testnet"; chainId: 296; strategies: StrategyRecord[]; topUps?: TopUp[] };

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
  const args = creditArgs(plan.slabs, { sellerSet: plan.sellerSet, maxPerBuyer: MAX_PER_BUYER, minReserve: MIN_RESERVE });
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

/** Tops the lender up to what its plan ships, from the operator, when something is still to ship. */
async function topUp(file: StrategiesFile, open: Set<Hex>, lender: LenderName, maker: Address, shipments: Shipment[]): Promise<void> {
  const toShip = (await Promise.all(shipments.map(async (s) => (open.has(await s.hash()) ? 0 : 1)))).some(Boolean);
  if (!toShip) return;
  const required = shipments.reduce((sum, s) => sum + s.usdc, 0n);
  const balance = await pub.readContract({ address: aqua.usdc, abi: erc20Abi, functionName: "balanceOf", args: [maker] });
  if (balance >= required) return;
  const units = required - balance;
  const vars = env as unknown as Record<string, string>;
  const transactionId = await transferUsdc(hieroClient(env), {
    tokenId: env.USDC_TOKEN_ID,
    from: env.HEDERA_OPERATOR_ID,
    fromKey: env.HEDERA_OPERATOR_KEY,
    to: vars[`LENDER_${lender}_ID`]!,
    units,
  });
  file.topUps = [...(file.topUps ?? []), { lender, units: units.toString(), transactionId, hashscan: hashscan.tx(transactionId) }];
  writeJson(STRATEGIES_FILE, file);
  console.log(`  ${lender}: topped up ${units} USDC units from the operator ${hashscan.tx(transactionId)}`);
}

async function allowanceToAqua(token: Address, owner: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, aqua.aqua] });
}

/** Discovery returns exactly the seven strategies, credit then base in shipping order, with the shipped balances and exact allowances. */
async function verify(file: StrategiesFile): Promise<LenderStrategy[]> {
  const found = await listOpenStrategies(pub, aqua, { fromBlock });
  const byHash = new Map(file.strategies.map((r) => [r.strategyHash, r]));
  const seen = found.map((s) => {
    const r = byHash.get(s.strategyHash);
    if (!r) throw new Error(`open strategy ${s.strategyHash} of ${s.maker} is not in strategies.json`);
    return `${s.kind}:${r.lender}`;
  });
  const want = ["credit:A", "credit:B", "credit:C", "credit:D", "base:A", "base:B", "base:C"];
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
  const shipments = shipmentsOf(wallet, LENDERS[lender]);
  await topUp(file, open, lender, wallet.account.address, shipments);
  for (const shipment of shipments) {
    await shipOnce(file, open, lender, wallet.account.address, shipment);
  }
}

console.log("verify: discovery from the Aqua deployment block");
const found = await verify(file);
for (const s of found) {
  const r = file.strategies.find((x) => x.strategyHash === s.strategyHash)!;
  console.log(`  ${r.kind} ${r.lender} ${s.args ? `slabs ${slabsOf(s.args.slabMask).join("+")}` : `fee ${s.feeBps} bps`} ${r.tx.hashscan}`);
}
