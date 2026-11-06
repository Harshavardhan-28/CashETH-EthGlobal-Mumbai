/**
 * C2: identity and receivable registries on Hedera testnet.
 *
 *   (cd contracts && forge build) && pnpm abi:sync && pnpm -r build && \
 *     FORGE=/path/to/foundry/forge pnpm tsx scripts/c2-register-demo.ts
 *
 * Steps (each skipped when `deployments/testnet/c2.json` shows it done):
 *   1. deploy   - contracts/script/01_DeployCore.s.sol (KYARegistry + ReceivableRegistry, nothing wired),
 *                 addresses written to deployments/testnet/addresses.json.
 *   2. agents   - the KYA issuer registers seller, buyer, both workers and lenders A/B/C (skipped per agent
 *                 when `agent(address).level` is already non-zero).
 *   3. rejects  - the buyer signs the demo confirmation. A dry-run `eth_call` shows the only failing check is
 *                 the payee (nothing is wired, so no payTo can match), then two REAL transactions revert
 *                 on-chain: the signed confirmation (WRONG_PAYEE) and the same one with one byte of `r`
 *                 flipped (BAD_BUYER_SIG). Both revert reasons are decoded from the mirror node.
 *                 DUPLICATE_RECEIVABLE on testnet is proven after wiring (Task 4.3). `--skip-rejections` leaves
 *                 this step out (the redeploy after the schedule fix: the contract checks are unchanged).
 *
 * A redeploy (scripts/c4-redeploy-prepare.ts) leaves the kept contracts in addresses.json; step 1 adds the
 * new registries to them instead of starting a new file.
 */
import { existsSync } from "node:fs";
import { contracts } from "@casheth/hedera";
import {
  ReceivableRegistryAbi,
  computeReceivableId,
  hashReceivableConfirmation,
  hashscan,
  loadAddresses,
  receivableDomain,
  signReceivableConfirmation,
  type Addresses,
  type ReceivableConfirmation,
} from "@casheth/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  decodeErrorResult,
  getAddress,
  keccak256,
  sliceHex,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  env,
  forgeDeploy,
  gasOf,
  mirrorGet,
  readJson,
  ROOT,
  txRecord,
  writeJson,
  type Deployed,
  type Gas,
  type TxRecord,
} from "./spikes/lib.js";

const ADDRESSES_FILE = `${ROOT}deployments/testnet/addresses.json`;
const STATE_FILE = `${ROOT}deployments/testnet/c2.json`;
const REVERT_GAS = 300_000n;
const DAY = 86_400n;

type Step = TxRecord & { gas: Gas };

interface AgentRecord {
  label: string;
  address: Address;
  role: number;
  level: number;
  ownerGroupLabel: string;
  tx?: Step; // absent when the agent was already registered
}

interface Rejection {
  expected: string;
  tx: Step;
  status: string;
  errorMessage: Hex;
  decoded: string;
}

interface C2State {
  network: "testnet";
  chainId: 296;
  kyaRegistry: Deployed;
  receivableRegistry: Deployed;
  agents?: AgentRecord[];
  rejections?: {
    confirmation: Record<string, string>;
    receivableId: Hex;
    digest: Hex;
    onChainDigest: Hex;
    simulation: { result: string; preconditions: Record<string, string> };
    wrongPayee: Rejection;
    badBuyerSig: Rejection;
  };
}

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set; run pnpm setup:accounts`);
  return value;
}

const usdc = getAddress(env.USDC_EVM_ADDRESS);
const issuerKey = need("KYA_ISSUER_KEY", env.KYA_ISSUER_KEY) as Hex;
const buyerKey = need("BUYER_KEY", env.BUYER_KEY) as Hex;
const submitterKey = need("COORDINATOR_KEY", env.COORDINATOR_KEY) as Hex;
const SKIP_REJECTIONS = process.argv.includes("--skip-rejections");

// ------------------------------------------------------------------ 1. deploy

async function deploy(): Promise<C2State> {
  console.log("1. deploy: forge script 01_DeployCore through the Hashio relay");
  const issuer = getAddress(need("KYA_ISSUER_EVM", env.KYA_ISSUER_EVM));
  const { created } = await forgeDeploy("01_DeployCore.s.sol", { KYA_ISSUER_EVM: issuer, USDC_EVM_ADDRESS: usdc });
  const kyaRegistry = created.get("KYARegistry");
  const receivableRegistry = created.get("ReceivableRegistry");
  if (!kyaRegistry || !receivableRegistry) throw new Error("01_DeployCore did not create both registries");
  const deployer = privateKeyToAccount(env.HEDERA_OPERATOR_KEY as Hex).address;
  const addresses: Addresses = {
    ...(existsSync(ADDRESSES_FILE) ? loadAddresses() : { chainId: 296 }),
    kyaRegistry: kyaRegistry.address,
    receivableRegistry: receivableRegistry.address,
    usdc,
    deployedAt: new Date().toISOString(),
    deployer,
  };
  writeJson(ADDRESSES_FILE, addresses);
  const state: C2State = { network: "testnet", chainId: 296, kyaRegistry, receivableRegistry };
  writeJson(STATE_FILE, state);
  console.log(`  KYARegistry        ${hashscan.contract(kyaRegistry.contractId)} (${kyaRegistry.tx.hashscan})`);
  console.log(`  ReceivableRegistry ${hashscan.contract(receivableRegistry.contractId)} (${receivableRegistry.tx.hashscan})`);
  return state;
}

// ------------------------------------------------------------------ 2. agents

const AGENTS = [
  { label: "seller", prefix: "SELLER", role: 1, level: 2, group: "seller-co" },
  { label: "buyer", prefix: "BUYER", role: 2, level: 3, group: "buyer-co" },
  { label: "workerResearch", prefix: "WORKER_RESEARCH", role: 3, level: 2, group: "seller-co" },
  { label: "workerCompute", prefix: "WORKER_COMPUTE", role: 3, level: 2, group: "seller-co" },
  { label: "lenderA", prefix: "LENDER_A", role: 4, level: 2, group: "lender-a" },
  { label: "lenderB", prefix: "LENDER_B", role: 4, level: 2, group: "lender-b" },
  { label: "lenderC", prefix: "LENDER_C", role: 4, level: 2, group: "lender-c" },
] as const;

function agentAddress(prefix: string): Address {
  return getAddress(need(`${prefix}_EVM`, (env as Record<string, string | undefined>)[`${prefix}_EVM`]));
}

async function registerAgents(addresses: Addresses): Promise<AgentRecord[]> {
  console.log("2. agents: KYA issuer registers the demo agents");
  const { kya, clients } = contracts(env, { addresses, walletKey: issuerKey });
  const records: AgentRecord[] = [];
  for (const a of AGENTS) {
    const address = agentAddress(a.prefix);
    const record: AgentRecord = { label: a.label, address, role: a.role, level: a.level, ownerGroupLabel: a.group };
    const existing = await kya.read.agent([address]);
    if (existing.level !== 0) {
      console.log(`  ${a.label}: already registered (level ${existing.level})`);
      records.push(record);
      continue;
    }
    const agent = {
      uaidHash: keccak256(address), // placeholder until Task 2.4 publishes UAIDs
      ownerGroup: keccak256(toHex(a.group)),
      role: a.role,
      level: a.level,
      expiresAt: 0n,
      revoked: false,
      mandateHash: keccak256(toHex(`mandate-v1-${a.label}`)),
    };
    const gas = ((await kya.estimateGas.register([address, agent], { account: clients.wallet.account! })) * 13n) / 10n;
    const hash = await kya.write.register([address, agent], { gas, chain: clients.chain, account: clients.wallet.account! });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`register ${a.label} reverted (${hash})`);
    const after = await kya.read.agent([address]);
    if (after.level !== a.level || after.role !== a.role || after.ownerGroup !== agent.ownerGroup) {
      throw new Error(`register ${a.label}: on-chain agent does not match`);
    }
    record.tx = { ...(await txRecord(hash, `KYARegistry.register(${a.label})`)), gas: await gasOf(hash) };
    console.log(`  ${a.label} (role ${a.role}, level ${a.level}, ${a.group}): ${record.tx.hashscan}`);
    records.push(record);
  }
  return records;
}

// ------------------------------------------------------------------ 3. rejections

/** Same signature with one byte of `r` flipped. */
function tamper(sig: Hex): Hex {
  const first = Number.parseInt(sig.slice(2, 4), 16) ^ 0xff;
  return concatHex([toHex(first, { size: 1 }), sliceHex(sig, 1)]);
}

async function revertingRegister(
  label: string,
  expected: "WRONG_PAYEE" | "BAD_BUYER_SIG",
  addresses: Addresses,
  c: ReceivableConfirmation,
  sig: Hex,
): Promise<Rejection> {
  const { registry, clients } = contracts(env, { addresses, walletKey: submitterKey });
  // Explicit gas: estimation would surface the revert and block the send.
  const hash = await registry.write.register([c, sig], {
    gas: REVERT_GAS,
    chain: clients.chain,
    account: clients.wallet.account!,
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "reverted") throw new Error(`${label}: expected a revert, got ${receipt.status} (${hash})`);
  const result = await mirrorWait<{ result: string; error_message: Hex | null }>(`/contracts/results/${hash}`);
  const errorMessage = result.error_message;
  if (!errorMessage || !errorMessage.startsWith("0x")) {
    throw new Error(`${label}: mirror has no revert data (${String(errorMessage)})`);
  }
  const selector = toFunctionSelector(`${expected}()`);
  if (errorMessage.toLowerCase() !== selector) {
    throw new Error(`${label}: error_message ${errorMessage} is not ${expected}() ${selector}`);
  }
  const { errorName } = decodeErrorResult({ abi: ReceivableRegistryAbi, data: errorMessage });
  if (errorName !== expected) throw new Error(`${label}: decoded ${errorName}, expected ${expected}`);
  const tx = { ...(await txRecord(hash, label)), gas: await gasOf(hash) };
  console.log(`  ${label}: ${result.result} ${errorMessage} = ${errorName}() ${tx.hashscan}`);
  return { expected, tx, status: result.result, errorMessage, decoded: `${errorName}()` };
}

async function mirrorWait<T>(path: string): Promise<T> {
  for (let i = 0; i < 15; i++) {
    const r = await mirrorGet<T>(path).catch(() => undefined);
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`mirror: ${path} not found`);
}

async function rejections(addresses: Addresses): Promise<NonNullable<C2State["rejections"]>> {
  console.log("3. rejects: buyer-signed demo confirmation against the unwired registry");
  const { registry, kya, clients } = contracts(env, { addresses });
  const seller = agentAddress("SELLER");
  const buyerAccount = privateKeyToAccount(buyerKey);
  const buyer = buyerAccount.address;
  const now = (await clients.public.getBlock()).timestamp;
  const c: ReceivableConfirmation = {
    seller,
    buyer,
    currency: usdc,
    amount: 10_000_000n,
    dueDate: now + 30n * DAY,
    buyerRef: keccak256(toHex("PO-1001")),
    detailsCommitment: keccak256(toHex("demo-invoice-1001")),
    payTo: "0x0000000000000000000000000000000000000001", // stand-in: nothing is wired yet
    nonce: 0n,
    deadline: now + DAY,
  };
  const domain = receivableDomain(296, addresses.receivableRegistry!);
  const sig = await signReceivableConfirmation(buyerAccount, domain, c);
  const digest = hashReceivableConfirmation(domain, c);
  const onChainDigest = await registry.read.hashConfirmation([c]);
  if (onChainDigest !== digest) throw new Error(`TS digest ${digest} != on-chain hashConfirmation ${onChainDigest}`);
  const receivableId = computeReceivableId(buyer, c.buyerRef);
  if ((await registry.read.computeId([buyer, c.buyerRef])) !== receivableId) throw new Error("computeId mismatch");
  console.log(`  digest ${digest} matches on-chain hashConfirmation; id ${receivableId}`);

  // Every check after the payee, read from chain state: the payee is the only reason this can fail.
  const [nonce, registryUsdc, buyerLevel, sellerLevel, buyerGroup, sellerGroup, idState, wiredRouter] =
    await Promise.all([
      registry.read.nonces([buyer]),
      registry.read.USDC(),
      kya.read.level([buyer]),
      kya.read.level([seller]),
      kya.read.ownerGroup([buyer]),
      kya.read.ownerGroup([seller]),
      registry.read.state([receivableId]),
      registry.read.repaymentRouter(),
    ]);
  const preconditions = {
    duplicate: `state(id) = ${idState} (None)`,
    term: `dueDate - now = ${(c.dueDate - now) / DAY} days (1..120), deadline in ${(c.deadline - now) / 3600n} h`,
    nonce: `nonces(buyer) = ${nonce}, confirmation nonce = ${c.nonce}`,
    currency: `USDC() = ${registryUsdc}`,
    kya: `level(buyer) = ${buyerLevel} (>= 3), level(seller) = ${sellerLevel} (>= 2)`,
    ownerSeparation: `ownerGroup(buyer) != ownerGroup(seller): ${buyerGroup !== sellerGroup}`,
    payee: `repaymentRouter() = ${wiredRouter} (unwired), payTo = ${c.payTo}`,
  };
  const ok =
    idState === 0 &&
    nonce === c.nonce &&
    getAddress(registryUsdc) === usdc &&
    buyerLevel >= 3 &&
    sellerLevel >= 2 &&
    buyerGroup !== sellerGroup &&
    wiredRouter === "0x0000000000000000000000000000000000000000";
  if (!ok) throw new Error(`preconditions not met: ${JSON.stringify(preconditions)}`);

  let simulated = "no revert";
  try {
    await registry.simulate.register([c, sig], { account: privateKeyToAccount(submitterKey).address });
  } catch (err) {
    const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    simulated = revert instanceof ContractFunctionRevertedError ? `${revert.data?.errorName ?? "?"}()` : String(err);
  }
  if (simulated !== "WRONG_PAYEE()") throw new Error(`simulateContract: expected WRONG_PAYEE(), got ${simulated}`);
  console.log(`  simulateContract(register, valid confirmation) reverts ${simulated}; preconditions:`);
  for (const [k, v] of Object.entries(preconditions)) console.log(`    ${k}: ${v}`);

  const wrongPayee = await revertingRegister("register(signed confirmation)", "WRONG_PAYEE", addresses, c, sig);
  const badBuyerSig = await revertingRegister("register(r byte flipped)", "BAD_BUYER_SIG", addresses, c, tamper(sig));
  return {
    confirmation: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
    receivableId,
    digest,
    onChainDigest,
    simulation: { result: simulated, preconditions },
    wrongPayee,
    badBuyerSig,
  };
}

// ------------------------------------------------------------------ main

let state: C2State;
if (existsSync(STATE_FILE)) {
  state = readJson<C2State>(STATE_FILE);
  console.log(`1. deploy: done (KYARegistry ${state.kyaRegistry.address}, ReceivableRegistry ${state.receivableRegistry.address})`);
} else {
  state = await deploy();
}
const addresses = loadAddresses();

if (!state.agents) {
  state.agents = await registerAgents(addresses);
  writeJson(STATE_FILE, state);
} else {
  console.log("2. agents: done");
}

if (SKIP_REJECTIONS) {
  console.log("3. rejects: skipped (--skip-rejections)");
} else if (!state.rejections) {
  state.rejections = await rejections(addresses);
  writeJson(STATE_FILE, state);
} else {
  console.log("3. rejects: done");
}
console.log(`state: ${STATE_FILE}`);
