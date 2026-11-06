/**
 * Spike S1: official Aqua registry + unmodified AquaSwapVMRouter on Hedera testnet, one XYC fill
 * against real HTS USDC.
 *
 *   pnpm -r build && FORGE=/path/to/foundry/forge pnpm tsx scripts/spikes/s1-aqua-xyc.ts
 *
 * Steps (each skipped when `deployments/testnet/spike-aqua.json` shows it done):
 *   1. deploy  - runs contracts/script/00_DeployAquaSpike.s.sol through the Hashio relay and records
 *                the addresses (SPIKE_RECORD_ONLY=1 records an existing broadcast without re-running).
 *   2. ship    - mints TOKENB, lender A approves Aqua and ships a 1 USDC / 1 TOKENB XYC strategy.
 *   3. fill    - quotes from SpikeTaker's address, then SpikeTaker swaps 0.1 TOKENB -> USDC.
 *   4. verify  - mirror-node USDC balances of lender A and the taker contract.
 * Order and taker bytes always come from SpikeOrderBuilder (the pinned SwapVM libraries) via eth_call.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evmClients, mirror } from "@casheth/hedera";
import { hashscan, loadEnv, type Env } from "@casheth/shared";
import {
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACTS_DIR = `${ROOT}contracts`;
const DEPLOY_FILE = `${ROOT}deployments/testnet/spike-aqua.json`;
const BROADCAST_FILE = `${CONTRACTS_DIR}/broadcast/00_DeployAquaSpike.s.sol/296/run-latest.json`;

const SHIP_AMOUNT = 1_000_000n; // 1 USDC and 1 TOKENB of virtual balance (6 decimals)
const TAKER_TOKEN_B = 100_000n; // 0.1 TOKENB held by SpikeTaker
const FILL_AMOUNT = 100_000n; // exactIn: 0.1 TOKENB -> USDC
const FILL_GAS = 1_500_000n;

const orderTuple = "(address maker, uint256 traits, bytes data) order" as const;
const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function mint(address to, uint256 amount)",
  ]),
  aqua: parseAbi([
    "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
    "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
  ]),
  router: parseAbi([
    `function hash(${orderTuple}) view returns (bytes32)`,
    `function quote(${orderTuple}, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
  ]),
  builder: parseAbi([
    `function buildXycOrder(address maker, address tokenA, address tokenB) pure returns (${orderTuple}, bytes strategy)`,
    "function takerData(address taker, bool isExactIn, bool isAToB, uint256 threshold) pure returns (bytes)",
  ]),
  taker: parseAbi([
    `function fill(${orderTuple}, uint256 amount, bytes takerData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
    "function USDC() view returns (address)",
  ]),
} satisfies Record<string, Abi>;

interface TxRecord {
  label?: string;
  hash: Hex;
  transactionId: string;
  hashscan: string;
}

interface Deployed {
  address: Address;
  contractId: string;
  tx: TxRecord;
}

interface SpikeState {
  network: "testnet";
  chainId: 296;
  deployPath: string;
  owner: Address;
  usdc: Address;
  whbar: Address;
  aqua: Address;
  router: Address;
  tokenB: Address;
  builder: Address;
  taker: Address;
  contracts: Record<"aqua" | "router" | "tokenB" | "builder" | "taker", Deployed>;
  ship?: {
    maker: Address;
    strategyHash: Hex;
    amounts: { usdc: string; tokenB: string };
    setupTxs: TxRecord[];
    tx: TxRecord;
  };
  fill?: {
    amountIn: string;
    quotedAmountOut: string;
    amountOut: string;
    isAToB: boolean;
    tx: TxRecord;
    balances: {
      before: Record<string, string>;
      after: Record<string, string>;
    };
  };
}

const env = loadEnv();
const lenderKey = required(env.LENDER_A_KEY, "LENDER_A_KEY") as Hex;
const lender = getAddress(required(env.LENDER_A_EVM, "LENDER_A_EVM"));
const lenderId = required(env.LENDER_A_ID, "LENDER_A_ID");
const usdc = getAddress(env.USDC_EVM_ADDRESS);
const operatorClients = evmClients(env, env.HEDERA_OPERATOR_KEY as Hex);
const lenderClients = evmClients(env, lenderKey);
const pub = operatorClients.public;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is missing; run scripts/setup-accounts.ts first`);
  return value;
}

function saveState(state: SpikeState): void {
  mkdirSync(dirname(DEPLOY_FILE), { recursive: true });
  writeFileSync(DEPLOY_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function txRecord(hash: Hex): Promise<TxRecord> {
  const { transactionId, hashscanUrl } = await mirror.waitFor(() => mirror.txByHash(env, hash));
  return { hash, transactionId, hashscan: hashscanUrl };
}

/** Mirror-node error for a failed EVM transaction (revert reason / Hedera status). */
async function mirrorError(hash: Hex): Promise<string> {
  const base = env.HEDERA_MIRROR_NODE_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const res = await fetch(`${base}/api/v1/contracts/results/${hash}`);
  const body = (await res.json()) as { result?: string; error_message?: string };
  return `${body.result ?? "?"} ${body.error_message ?? ""}`.trim();
}

/** Sends a contract write, waits for the receipt and fails loudly with the mirror-node reason. */
async function send(
  wallet: WalletClient,
  label: string,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; gas?: bigint },
): Promise<TxRecord> {
  const hash = await wallet.writeContract({
    ...request,
    account: wallet.account!,
    chain: operatorClients.chain,
  } as Parameters<WalletClient["writeContract"]>[0]);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const reason = await mirror.waitFor(() => mirrorError(hash)).catch(() => "unknown");
    throw new Error(`${label} reverted (${hash}): ${reason}`);
  }
  const record = { label, ...(await txRecord(hash)) };
  console.log(`  ${label}: ${record.transactionId} ${record.hashscan}`);
  return record;
}

// ---------------------------------------------------------------- 1. deploy

async function deploy(): Promise<SpikeState> {
  if (process.env.SPIKE_RECORD_ONLY !== "1") {
    console.log("1. deploy: forge script 00_DeployAquaSpike through the Hashio relay");
    execFileSync(
      process.env.FORGE ?? "forge",
      [
        "script",
        "script/00_DeployAquaSpike.s.sol",
        "--rpc-url",
        env.HEDERA_JSON_RPC_URL,
        "--private-key",
        env.HEDERA_OPERATOR_KEY,
        "--broadcast",
        "--legacy",
        "--slow",
        // Forge's replay simulation cannot run HTS `associate()` (no system contract in revm).
        "--skip-simulation",
        "--gas-estimate-multiplier",
        "130",
      ],
      { cwd: CONTRACTS_DIR, stdio: "inherit", env: { ...process.env, USDC_EVM_ADDRESS: usdc } },
    );
  } else {
    console.log("1. deploy: recording the existing forge broadcast");
  }

  const broadcast = JSON.parse(readFileSync(BROADCAST_FILE, "utf8")) as {
    transactions: { contractName: string; contractAddress: Address; hash: Hex; transaction: { from: Address } }[];
    receipts: { status: string; contractAddress: Address; transactionHash: Hex }[];
  };
  const byName = new Map<string, Deployed>();
  for (const [i, t] of broadcast.transactions.entries()) {
    const receipt = broadcast.receipts[i];
    if (!receipt || receipt.status !== "0x1") throw new Error(`${t.contractName} creation did not succeed`);
    const address = getAddress(receipt.contractAddress);
    const info = await mirror.waitFor(async () => {
      const base = env.HEDERA_MIRROR_NODE_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
      const res = await fetch(`${base}/api/v1/contracts/${address}`);
      return res.ok ? ((await res.json()) as { contract_id: string }) : undefined;
    });
    byName.set(t.contractName, { address, contractId: info.contract_id, tx: await txRecord(receipt.transactionHash) });
  }
  const pick = (name: string): Deployed => {
    const d = byName.get(name);
    if (!d) throw new Error(`broadcast has no ${name}`);
    return d;
  };
  const contracts = {
    aqua: pick("AquaRouter"),
    router: pick("AquaSwapVMRouter"),
    tokenB: pick("SpikeTokenB"),
    builder: pick("SpikeOrderBuilder"),
    taker: pick("SpikeTaker"),
  };
  const state: SpikeState = {
    network: "testnet",
    chainId: 296,
    deployPath: "forge script --broadcast --legacy --slow --skip-simulation via Hashio JSON-RPC relay",
    owner: getAddress(broadcast.transactions[0]!.transaction.from),
    usdc,
    whbar: getAddress("0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed"),
    aqua: contracts.aqua.address,
    router: contracts.router.address,
    tokenB: contracts.tokenB.address,
    builder: contracts.builder.address,
    taker: contracts.taker.address,
    contracts,
  };
  saveState(state);
  return state;
}

// ---------------------------------------------------------------- order helpers

type Order = { maker: Address; traits: bigint; data: Hex };

async function buildOrder(state: SpikeState): Promise<{ order: Order; strategy: Hex; strategyHash: Hex }> {
  const [order, strategy] = await pub.readContract({
    address: state.builder,
    abi: ABI.builder,
    functionName: "buildXycOrder",
    args: [lender, usdc, state.tokenB],
  });
  const strategyHash = keccak256(strategy);
  const routerHash = await pub.readContract({ address: state.router, abi: ABI.router, functionName: "hash", args: [order] });
  if (routerHash !== strategyHash) throw new Error(`router.hash(order) ${routerHash} != keccak256(strategy) ${strategyHash}`);
  return { order, strategy, strategyHash };
}

const balanceOf = (token: Address, who: Address): Promise<bigint> =>
  pub.readContract({ address: token, abi: ABI.erc20, functionName: "balanceOf", args: [who] });

// ---------------------------------------------------------------- 2. ship

async function ship(state: SpikeState): Promise<SpikeState> {
  const { strategy, strategyHash } = await buildOrder(state);
  const [, tokensCount] = await pub.readContract({
    address: state.aqua,
    abi: ABI.aqua,
    functionName: "rawBalances",
    args: [lender, state.router, strategyHash, usdc],
  });
  if (state.ship && tokensCount > 0) {
    console.log(`2. ship: already shipped ${strategyHash} (${state.ship.tx.hashscan})`);
    return state;
  }
  if (tokensCount > 0) throw new Error(`strategy ${strategyHash} is active on-chain but not recorded in ${DEPLOY_FILE}`);

  console.log("2. ship");
  const operator = operatorClients.wallet!;
  const lenderWallet = lenderClients.wallet!;
  const setupTxs: TxRecord[] = [];
  if ((await balanceOf(state.tokenB, lender)) < SHIP_AMOUNT) {
    setupTxs.push(await send(operator, "mint 1 TOKENB to lender A", {
      address: state.tokenB, abi: ABI.erc20, functionName: "mint", args: [lender, SHIP_AMOUNT],
    }));
  }
  if ((await balanceOf(state.tokenB, state.taker)) < TAKER_TOKEN_B) {
    setupTxs.push(await send(operator, "mint 0.1 TOKENB to SpikeTaker", {
      address: state.tokenB, abi: ABI.erc20, functionName: "mint", args: [state.taker, TAKER_TOKEN_B],
    }));
  }
  // HTS allowances are int64-bounded, so USDC gets exactly the shipped amount (all Aqua can pull).
  const approvals: [Address, bigint, string][] = [
    [usdc, SHIP_AMOUNT, "lender A approves Aqua for 1 USDC (HTS allowance via facade)"],
    [state.tokenB, maxUint256, "lender A approves Aqua for TOKENB"],
  ];
  for (const [token, amount, label] of approvals) {
    const current = await pub.readContract({ address: token, abi: ABI.erc20, functionName: "allowance", args: [lender, state.aqua] });
    if (current < SHIP_AMOUNT) {
      setupTxs.push(await send(lenderWallet, label, {
        address: token, abi: ABI.erc20, functionName: "approve", args: [state.aqua, amount],
      }));
    }
  }
  const tx = await send(lenderWallet, "lender A ships XYC strategy", {
    address: state.aqua,
    abi: ABI.aqua,
    functionName: "ship",
    args: [state.router, strategy, [usdc, state.tokenB], [SHIP_AMOUNT, SHIP_AMOUNT]],
  });
  state.ship = {
    maker: lender,
    strategyHash,
    amounts: { usdc: SHIP_AMOUNT.toString(), tokenB: SHIP_AMOUNT.toString() },
    setupTxs,
    tx,
  };
  saveState(state);
  return state;
}

// ---------------------------------------------------------------- 3. fill + 4. verify

async function snapshot(state: SpikeState): Promise<Record<string, string>> {
  return {
    lenderUsdc: (await mirror.tokenBalance(env, lenderId, env.USDC_TOKEN_ID)).toString(),
    takerUsdc: (await mirror.tokenBalance(env, state.contracts.taker.contractId, env.USDC_TOKEN_ID)).toString(),
    lenderTokenB: (await balanceOf(state.tokenB, lender)).toString(),
    takerTokenB: (await balanceOf(state.tokenB, state.taker)).toString(),
  };
}

async function fill(state: SpikeState): Promise<SpikeState> {
  if (state.fill) {
    console.log(`3. fill: already filled (${state.fill.tx.hashscan})`);
    return state;
  }
  console.log("3. fill");
  const { order, strategyHash } = await buildOrder(state);
  // Sorted pair: tokenA is the lower address; the taker sells TOKENB.
  const isAToB = BigInt(state.tokenB) < BigInt(usdc);
  const quoteData = await pub.readContract({
    address: state.builder, abi: ABI.builder, functionName: "takerData", args: [state.taker, true, isAToB, 0n],
  });
  const [quotedIn, quotedOut, quotedHash] = await pub.readContract({
    address: state.router,
    abi: ABI.router,
    functionName: "quote",
    args: [order, FILL_AMOUNT, quoteData],
    account: state.taker,
  });
  console.log(`  quote from SpikeTaker: ${quotedIn} TOKENB in -> ${quotedOut} USDC out (orderHash ${quotedHash})`);
  if (quotedHash !== strategyHash) throw new Error("quote orderHash differs from the shipped strategy hash");

  // Fill with the quoted amount as the min-out threshold.
  const takerData = await pub.readContract({
    address: state.builder, abi: ABI.builder, functionName: "takerData", args: [state.taker, true, isAToB, quotedOut],
  });
  const before = await snapshot(state);
  console.log("  before:", before);
  const tx = await send(operatorClients.wallet!, "SpikeTaker.fill 0.1 TOKENB -> USDC", {
    address: state.taker,
    abi: ABI.taker,
    functionName: "fill",
    args: [order, FILL_AMOUNT, takerData],
    gas: FILL_GAS,
  });

  const expectedLender = BigInt(before.lenderUsdc!) - quotedOut;
  await mirror.waitFor(async () =>
    (await mirror.tokenBalance(env, lenderId, env.USDC_TOKEN_ID)) === expectedLender);
  const after = await snapshot(state);
  console.log("  after: ", after);

  const lenderUsdcDelta = BigInt(before.lenderUsdc!) - BigInt(after.lenderUsdc!);
  const takerUsdcDelta = BigInt(after.takerUsdc!) - BigInt(before.takerUsdc!);
  const lenderTokenBDelta = BigInt(after.lenderTokenB!) - BigInt(before.lenderTokenB!);
  if (lenderUsdcDelta !== quotedOut || takerUsdcDelta !== quotedOut || lenderTokenBDelta !== FILL_AMOUNT) {
    throw new Error(
      `unexpected balance deltas: lender USDC -${lenderUsdcDelta}, taker USDC +${takerUsdcDelta}, lender TOKENB +${lenderTokenBDelta}`,
    );
  }
  console.log(`4. verify: lender A USDC -${lenderUsdcDelta}, SpikeTaker USDC +${takerUsdcDelta}, lender A TOKENB +${lenderTokenBDelta}`);

  state.fill = {
    amountIn: FILL_AMOUNT.toString(),
    quotedAmountOut: quotedOut.toString(),
    amountOut: takerUsdcDelta.toString(),
    isAToB,
    tx,
    balances: { before, after },
  };
  saveState(state);
  return state;
}

function report(state: SpikeState, e: Env): void {
  console.log("\nAddresses:");
  for (const [name, d] of Object.entries(state.contracts)) {
    console.log(`  ${name.padEnd(8)} ${d.address} ${d.contractId} ${hashscan.contract(d.contractId)}`);
  }
  console.log(`  lenderA  ${lender} ${lenderId} ${hashscan.account(lenderId)}`);
  console.log(`  usdc     ${state.usdc} ${e.USDC_TOKEN_ID} ${hashscan.token(e.USDC_TOKEN_ID)}`);
}

let state: SpikeState;
if (existsSync(DEPLOY_FILE)) {
  console.log(`1. deploy: using ${DEPLOY_FILE}`);
  state = JSON.parse(readFileSync(DEPLOY_FILE, "utf8")) as SpikeState;
} else {
  state = await deploy();
}
state = await ship(state);
state = await fill(state);
report(state, env);
