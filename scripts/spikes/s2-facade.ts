/**
 * Spike S2: a contract associates with HTS USDC through the HIP-719 facade in its constructor, then
 * pulls an approved amount with the facade's `transferFrom` and pushes it back with `transfer`.
 *
 *   pnpm -r build && FORGE=/path/to/foundry/forge pnpm tsx scripts/spikes/s2-facade.ts
 *
 * Steps (each skipped when `deployments/testnet/spike-s2.json` shows it done):
 *   1. deploy - contracts/script/01_DeploySpikeS2.s.sol (AssocProbe(usdc)) through the Hashio relay.
 *   2. flow   - operator approve(probe, 1 USDC) on the facade, probe.pull(operator, 0.5 USDC),
 *               probe.push(operator, 0.5 USDC); the probe's USDC is checked on the mirror node
 *               after each step (0 -> 500000 -> 0).
 */
import { existsSync } from "node:fs";
import { mirror } from "@casheth/hedera";
import { hashscan } from "@casheth/shared";
import { getAddress, parseAbi, type Address } from "viem";
import { env, forgeDeploy, mirrorGet, pub, readJson, ROOT, send, wallet, writeJson, type Deployed, type TxRecord, type Gas } from "./lib.js";

const DEPLOY_FILE = `${ROOT}deployments/testnet/spike-s2.json`;
const APPROVE_AMOUNT = 1_000_000n; // exactly 1 USDC: HTS allowances are int64, max uint256 reverts
const MOVE_AMOUNT = 500_000n; // 0.5 USDC

const ABI = {
  erc20: parseAbi([
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ]),
  probe: parseAbi([
    "function pull(address from, uint256 amount)",
    "function push(address to, uint256 amount)",
    "function isAssociated() view returns (bool)",
    "function balance() view returns (uint256)",
  ]),
};

type Step = TxRecord & { gas: Gas };

interface S2State {
  network: "testnet";
  chainId: 296;
  deployPath: string;
  operator: Address;
  usdc: Address;
  probe: Deployed;
  flow?: {
    approve: Step;
    pull: Step;
    push: Step;
    isAssociated: boolean;
    probeUsdc: { before: string; afterPull: string; afterPush: string };
    operatorUsdc: { before: string; afterPull: string; afterPush: string };
  };
}

const usdc = getAddress(env.USDC_EVM_ADDRESS);
const operatorAddress = wallet.account!.address;

async function deploy(): Promise<S2State> {
  console.log("1. deploy: forge script 01_DeploySpikeS2 through the Hashio relay");
  const { created } = await forgeDeploy("01_DeploySpikeS2.s.sol", { USDC_EVM_ADDRESS: usdc });
  const probe = created.get("AssocProbe");
  if (!probe) throw new Error("broadcast has no AssocProbe");
  const state: S2State = {
    network: "testnet",
    chainId: 296,
    deployPath: "forge script --broadcast --legacy --slow --skip-simulation via Hashio JSON-RPC relay",
    operator: operatorAddress,
    usdc,
    probe,
  };
  writeJson(DEPLOY_FILE, state);
  return state;
}

const probeUsdc = (s: S2State): Promise<bigint> => mirror.tokenBalance(env, s.probe.contractId, env.USDC_TOKEN_ID);
const operatorUsdc = (): Promise<bigint> => mirror.tokenBalance(env, env.HEDERA_OPERATOR_ID, env.USDC_TOKEN_ID);

async function waitProbeUsdc(s: S2State, expected: bigint): Promise<void> {
  await mirror.waitFor(async () => (await probeUsdc(s)) === expected, { attempts: 15 });
}

async function flow(s: S2State): Promise<S2State> {
  if (s.flow) {
    console.log(`2. flow: already done (push ${s.flow.push.hashscan})`);
    return s;
  }
  console.log("2. flow");
  // Association: facade view through the probe, and the token relationship on the mirror node.
  const isAssociated = await pub.readContract({ address: s.probe.address, abi: ABI.probe, functionName: "isAssociated" });
  const rel = await mirrorGet<{ tokens: { token_id: string }[] }>(
    `/accounts/${s.probe.contractId}/tokens?token.id=${env.USDC_TOKEN_ID}`,
  );
  if (!isAssociated || !rel?.tokens.some((t) => t.token_id === env.USDC_TOKEN_ID)) {
    throw new Error(`probe ${s.probe.contractId} is not associated with ${env.USDC_TOKEN_ID}`);
  }
  console.log(`  probe.isAssociated() = ${isAssociated}; mirror lists ${env.USDC_TOKEN_ID} on ${s.probe.contractId}`);

  const probeBefore = await probeUsdc(s);
  const operatorBefore = await operatorUsdc();
  if (probeBefore !== 0n) throw new Error(`probe starts with ${probeBefore} USDC units, expected 0`);
  console.log(`  probe USDC ${probeBefore}, operator USDC ${operatorBefore}`);

  const approve = await send("operator approve(probe, 1 USDC) on the facade", {
    address: usdc, abi: ABI.erc20, functionName: "approve", args: [s.probe.address, APPROVE_AMOUNT],
  });
  const allowance = await pub.readContract({
    address: usdc, abi: ABI.erc20, functionName: "allowance", args: [operatorAddress, s.probe.address],
  });
  if (allowance !== APPROVE_AMOUNT) throw new Error(`allowance ${allowance}, expected ${APPROVE_AMOUNT}`);

  const pull = await send("probe.pull(operator, 0.5 USDC) - facade transferFrom", {
    address: s.probe.address, abi: ABI.probe, functionName: "pull", args: [operatorAddress, MOVE_AMOUNT],
  });
  await waitProbeUsdc(s, MOVE_AMOUNT);
  const probeAfterPull = await probeUsdc(s);
  const operatorAfterPull = await operatorUsdc();
  console.log(`  after pull: probe USDC ${probeAfterPull}, operator USDC ${operatorAfterPull}`);

  const push = await send("probe.push(operator, 0.5 USDC) - facade transfer", {
    address: s.probe.address, abi: ABI.probe, functionName: "push", args: [operatorAddress, MOVE_AMOUNT],
  });
  await waitProbeUsdc(s, 0n);
  const probeAfterPush = await probeUsdc(s);
  const operatorAfterPush = await mirror.waitFor(async () => {
    const b = await operatorUsdc();
    return b === operatorBefore ? b : undefined;
  });
  console.log(`  after push: probe USDC ${probeAfterPush}, operator USDC ${operatorAfterPush}`);

  s.flow = {
    approve,
    pull,
    push,
    isAssociated,
    probeUsdc: { before: `${probeBefore}`, afterPull: `${probeAfterPull}`, afterPush: `${probeAfterPush}` },
    operatorUsdc: { before: `${operatorBefore}`, afterPull: `${operatorAfterPull}`, afterPush: `${operatorAfterPush}` },
  };
  writeJson(DEPLOY_FILE, s);
  return s;
}

let state: S2State;
if (existsSync(DEPLOY_FILE)) {
  console.log(`1. deploy: using ${DEPLOY_FILE}`);
  state = readJson<S2State>(DEPLOY_FILE);
} else {
  state = await deploy();
}
state = await flow(state);

const g = (x: Gas): string => `limit ${x.limit}, used ${x.used}, consumed ${x.consumed}`;
console.log(`\nAssocProbe ${state.probe.address} ${state.probe.contractId} ${hashscan.contract(state.probe.contractId)}`);
console.log(`  deploy (constructor with associate()): ${state.probe.tx.hashscan} (${g(state.probe.gas)})`);
if (state.flow) {
  for (const k of ["approve", "pull", "push"] as const) {
    console.log(`  ${k.padEnd(7)} ${state.flow[k].hashscan} (${g(state.flow[k].gas)})`);
  }
}
