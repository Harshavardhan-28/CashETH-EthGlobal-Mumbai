/**
 * C3: Receivable Credit Note, credit facility and repayment router on Hedera testnet.
 *
 *   (cd contracts && forge build) && pnpm abi:sync && pnpm -r build && \
 *     FORGE=/path/to/foundry/forge pnpm tsx scripts/c3-deploy.ts
 *
 * Steps (the deploy is skipped when `deployments/testnet/c3.json` shows it done):
 *   1. deploy - contracts/script/02_DeployFacility.s.sol through the Hashio relay, against the registries C2
 *               deployed: ReceivableCreditNote (owner = operator), CreditFacility (coordinator = COORDINATOR_EVM,
 *               owner = operator), RepaymentRouter; 20 HBAR into the facility's `receive()` (explicit gas 60,000:
 *               the relay cannot estimate a creation that carries value); `registry.wire(facility, router)` and
 *               `kya.wire(router, facility)` (note the argument order differs). `rcn.wire` and `facility.wire`
 *               need the SwapVM router and are Task 4.3's.
 *   2. verify - reads back both registries' wiring, every immutable of the facility and router, the owners,
 *               the facility's HBAR balance, and (mirror node) the facility's and router's USDC association.
 *               Writes `rcn`, `creditFacility`, `repaymentRouter` into deployments/testnet/addresses.json.
 */
import { existsSync } from "node:fs";
import {
  CreditFacilityAbi,
  KYARegistryAbi,
  ReceivableCreditNoteAbi,
  ReceivableRegistryAbi,
  RepaymentRouterAbi,
  hashscan,
  loadAddresses,
  type Addresses,
} from "@casheth/shared";
import { mirror } from "@casheth/hedera";
import { formatEther, getAddress, isAddressEqual, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  env,
  forgeDeploy,
  mirrorGet,
  pub,
  readJson,
  ROOT,
  writeJson,
  type Deployed,
  type Gas,
  type TxRecord,
} from "./spikes/lib.js";

const ADDRESSES_FILE = `${ROOT}deployments/testnet/addresses.json`;
const STATE_FILE = `${ROOT}deployments/testnet/c3.json`;
const FUNDING_WEIBARS = 20n * 10n ** 18n; // 20 HBAR in the relay's 18-decimal units

type Step = TxRecord & { gas: Gas };

interface C3State {
  network: "testnet";
  chainId: 296;
  deployer: Address;
  coordinator: Address;
  kyaRegistry: Address;
  receivableRegistry: Address;
  usdc: Address;
  rcn: Deployed;
  creditFacility: Deployed;
  repaymentRouter: Deployed;
  funding: Step;
  wireRegistry: Step;
  wireKya: Step;
  verified?: Record<string, string>;
}

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set; run pnpm setup:accounts`);
  return value;
}

const addresses = loadAddresses();
const kyaRegistry = getAddress(need("addresses.kyaRegistry", addresses.kyaRegistry));
const receivableRegistry = getAddress(need("addresses.receivableRegistry", addresses.receivableRegistry));
const usdc = getAddress(env.USDC_EVM_ADDRESS);
const coordinator = getAddress(need("COORDINATOR_EVM", (env as Record<string, string | undefined>).COORDINATOR_EVM));
const deployer = privateKeyToAccount(env.HEDERA_OPERATOR_KEY as Hex).address;

// ------------------------------------------------------------------ 1. deploy

async function deploy(): Promise<C3State> {
  console.log("1. deploy: forge script 02_DeployFacility through the Hashio relay");
  const { created, calls } = await forgeDeploy("02_DeployFacility.s.sol", {
    KYA_REGISTRY: kyaRegistry,
    RECEIVABLE_REGISTRY: receivableRegistry,
    USDC_EVM_ADDRESS: usdc,
    COORDINATOR_EVM: coordinator,
  });
  const rcn = created.get("ReceivableCreditNote");
  const creditFacility = created.get("CreditFacility");
  const repaymentRouter = created.get("RepaymentRouter");
  if (!rcn || !creditFacility || !repaymentRouter) throw new Error("02_DeployFacility did not create all three contracts");
  const [funding, wireRegistry, wireKya] = calls;
  if (calls.length !== 3 || !funding || !wireRegistry || !wireKya) {
    throw new Error(`02_DeployFacility broadcast ${calls.length} calls, expected funding + two wire calls`);
  }
  const state: C3State = {
    network: "testnet",
    chainId: 296,
    deployer,
    coordinator,
    kyaRegistry,
    receivableRegistry,
    usdc,
    rcn,
    creditFacility,
    repaymentRouter,
    funding: { ...funding, label: "fund CreditFacility with 20 HBAR via receive()" },
    wireRegistry: { ...wireRegistry, label: "ReceivableRegistry.wire(facility, repaymentRouter)" },
    wireKya: { ...wireKya, label: "KYARegistry.wire(repaymentRouter, facility)" },
  };
  writeJson(STATE_FILE, state);
  return state;
}

// ------------------------------------------------------------------ 2. verify

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await pub.readContract({ address, abi, functionName, args } as Parameters<typeof pub.readContract>[0])) as T;
}

function expectAddress(label: string, actual: Address, expected: Address, out: Record<string, string>): void {
  if (!isAddressEqual(actual, expected)) throw new Error(`${label} = ${actual}, expected ${expected}`);
  out[label] = actual;
  console.log(`  ${label} = ${actual}`);
}

async function associated(contractId: string): Promise<boolean> {
  const r = await mirror.waitFor(() =>
    mirrorGet<{ tokens: { token_id: string }[] }>(`/accounts/${contractId}/tokens?token.id=${env.USDC_TOKEN_ID}`),
  );
  return r.tokens.some((t) => t.token_id === env.USDC_TOKEN_ID);
}

async function verify(s: C3State): Promise<Record<string, string>> {
  console.log("2. verify: on-chain wiring, immutables, owners, HBAR and USDC association");
  const facility = s.creditFacility.address;
  const router = s.repaymentRouter.address;
  const rcn = s.rcn.address;
  const out: Record<string, string> = {};

  expectAddress("registry.facility()", await read(receivableRegistry, ReceivableRegistryAbi, "facility"), facility, out);
  expectAddress(
    "registry.repaymentRouter()",
    await read(receivableRegistry, ReceivableRegistryAbi, "repaymentRouter"),
    router,
    out,
  );
  expectAddress("kya.repaymentRouter()", await read(kyaRegistry, KYARegistryAbi, "repaymentRouter"), router, out);
  expectAddress("kya.facility()", await read(kyaRegistry, KYARegistryAbi, "facility"), facility, out);

  expectAddress("facility.REGISTRY()", await read(facility, CreditFacilityAbi, "REGISTRY"), receivableRegistry, out);
  expectAddress("facility.KYA()", await read(facility, CreditFacilityAbi, "KYA"), kyaRegistry, out);
  expectAddress("facility.RCN()", await read(facility, CreditFacilityAbi, "RCN"), rcn, out);
  expectAddress("facility.USDC()", await read(facility, CreditFacilityAbi, "USDC"), usdc, out);
  expectAddress("facility.COORDINATOR()", await read(facility, CreditFacilityAbi, "COORDINATOR"), coordinator, out);
  expectAddress("facility.owner()", await read(facility, CreditFacilityAbi, "owner"), deployer, out);
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  expectAddress("facility.swapRouter() (Task 4.3)", await read(facility, CreditFacilityAbi, "swapRouter"), zero, out);

  expectAddress("router.REGISTRY()", await read(router, RepaymentRouterAbi, "REGISTRY"), receivableRegistry, out);
  expectAddress("router.KYA()", await read(router, RepaymentRouterAbi, "KYA"), kyaRegistry, out);
  expectAddress("router.FACILITY()", await read(router, RepaymentRouterAbi, "FACILITY"), facility, out);
  expectAddress("router.RCN()", await read(router, RepaymentRouterAbi, "RCN"), rcn, out);
  expectAddress("router.USDC()", await read(router, RepaymentRouterAbi, "USDC"), usdc, out);

  expectAddress("rcn.owner()", await read(rcn, ReceivableCreditNoteAbi, "owner"), deployer, out);
  expectAddress("rcn.facility() (Task 4.3)", await read(rcn, ReceivableCreditNoteAbi, "facility"), zero, out);

  const hbar = await pub.getBalance({ address: facility });
  if (hbar < FUNDING_WEIBARS) throw new Error(`facility holds ${formatEther(hbar)} HBAR, expected >= 20`);
  out["facility HBAR"] = formatEther(hbar);
  console.log(`  facility HBAR = ${formatEther(hbar)}`);

  for (const [label, d] of [
    ["facility", s.creditFacility],
    ["router", s.repaymentRouter],
  ] as const) {
    if (!(await associated(d.contractId))) throw new Error(`${label} ${d.contractId} is not associated with USDC`);
    out[`${label} USDC association`] = `${d.contractId} <-> ${env.USDC_TOKEN_ID}`;
    console.log(`  ${label} ${d.contractId} associated with USDC ${env.USDC_TOKEN_ID}`);
  }
  return out;
}

// ------------------------------------------------------------------ main

let state: C3State = existsSync(STATE_FILE) ? readJson<C3State>(STATE_FILE) : await deploy();
state = { ...state, verified: await verify(state) };
writeJson(STATE_FILE, state);

const updated: Addresses = {
  ...addresses,
  rcn: state.rcn.address,
  creditFacility: state.creditFacility.address,
  repaymentRouter: state.repaymentRouter.address,
};
writeJson(ADDRESSES_FILE, updated);

console.log("\nC3 summary");
for (const [label, d] of [
  ["ReceivableCreditNote", state.rcn],
  ["CreditFacility", state.creditFacility],
  ["RepaymentRouter", state.repaymentRouter],
] as const) {
  console.log(`  ${label.padEnd(20)} ${d.address} ${hashscan.contract(d.contractId)} (deploy ${d.tx.hashscan}, gas used ${d.gas.used})`);
}
for (const step of [state.funding, state.wireRegistry, state.wireKya]) {
  console.log(`  ${step.label}: ${step.hashscan} (gas used ${step.gas.used})`);
}
console.log(`  addresses: ${ADDRESSES_FILE}`);
