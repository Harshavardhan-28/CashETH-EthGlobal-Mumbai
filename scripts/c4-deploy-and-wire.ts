/**
 * C4 (Task 4.3): CashETH's Aqua registry, the modified SwapVM router, the order builder, tUSDT and the
 * trader's taker on Hedera testnet, plus the last one-time wiring of the core contracts.
 *
 *   (cd contracts && forge build) && pnpm abi:sync && pnpm -r build && \
 *     FORGE=/path/to/foundry/forge pnpm tsx scripts/c4-deploy-and-wire.ts
 *
 * Steps (each skipped when `deployments/testnet/c4.json` shows it done):
 *   1. deploy - contracts/script/03_DeployAqua.s.sol through the Hashio relay (the S1 path, D-P10):
 *               AquaRouter(owner = operator), CashEthSwapVMRouter(aqua, WHBAR, operator, "CashETH SwapVM",
 *               "1.0.0", registry, kya, facility), CashEthOrderBuilder, TestStablecoin (tUSDT, owner =
 *               operator) and CashEthTaker(router, USDC, owner = operator), with each creation's block. After a
 *               redeploy (`kept` in c4.json) Aqua, the order builder and tUSDT are reused: only the router and
 *               the taker, which hold the facility address, are created.
 *   2. wire   - `rcn.wire(facility, repaymentRouter, swapRouter, aqua)` and
 *               `facility.wire(swapRouter, repaymentRouter)`, both one-time, sent from the operator.
 *   3. mint   - tUSDT: 50 to lenders A, B and C, 20 to the operator (the trader). Lender D's 50 are minted by
 *               scripts/c4-register.ts, which creates that account.
 *   4. verify - reads back every wiring getter, the router's immutables, owners and EIP-712 domain, tUSDT's
 *               metadata and balances, the taker's immutables and (mirror node) its USDC association.
 *               Writes `aqua`, `swapRouter`, `orderBuilder`, `tUsdt`, `taker` and `deployedBlock` into
 *               deployments/testnet/addresses.json.
 */
import {
  AquaRouterAbi,
  CashEthSwapVMRouterAbi,
  CashEthTakerAbi,
  CreditFacilityAbi,
  ReceivableCreditNoteAbi,
  TestStablecoinAbi,
  hashscan,
  loadAddresses,
  type Addresses,
} from "@casheth/shared";
import { mirror } from "@casheth/hedera";
import { getAddress, isAddressEqual, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, forgeDeploy, mirrorGet, pub, ROOT, send, writeJson, type Deployed } from "./spikes/lib.js";
import { mintTo, readC4, TUSDT_UNIT, writeC4, type C4State, type Deploy, type DeployedAt } from "./c4-state.js";

const ADDRESSES_FILE = `${ROOT}deployments/testnet/addresses.json`;
const WHBAR = getAddress("0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set; run the earlier checkpoints first`);
  return value;
}

const addresses = loadAddresses();
const kyaRegistry = getAddress(need("addresses.kyaRegistry", addresses.kyaRegistry));
const receivableRegistry = getAddress(need("addresses.receivableRegistry", addresses.receivableRegistry));
const rcn = getAddress(need("addresses.rcn", addresses.rcn));
const creditFacility = getAddress(need("addresses.creditFacility", addresses.creditFacility));
const repaymentRouter = getAddress(need("addresses.repaymentRouter", addresses.repaymentRouter));
const usdc = getAddress(env.USDC_EVM_ADDRESS);
const operator = privateKeyToAccount(env.HEDERA_OPERATOR_KEY as Hex).address;

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await pub.readContract({ address, abi, functionName, args } as Parameters<typeof pub.readContract>[0])) as T;
}

// ------------------------------------------------------------------ 1. deploy

async function withBlock(d: Deployed): Promise<DeployedAt> {
  const receipt = await pub.getTransactionReceipt({ hash: d.tx.hash });
  return { ...d, block: Number(receipt.blockNumber) };
}

/** The kept contracts as the deploy script's reuse variables. */
function keptEnv(kept: NonNullable<C4State["kept"]>): Record<string, string> {
  return { AQUA_ROUTER: kept.aqua.address, ORDER_BUILDER: kept.orderBuilder.address, TEST_STABLECOIN: kept.tUsdt.address };
}

async function deploy(kept: C4State["kept"]): Promise<Deploy> {
  console.log(`1. deploy: forge script 03_DeployAqua through the Hashio relay${kept ? " (Aqua, order builder and tUSDT kept)" : ""}`);
  const { created, calls } = await forgeDeploy("03_DeployAqua.s.sol", {
    USDC_EVM_ADDRESS: usdc,
    RECEIVABLE_REGISTRY: receivableRegistry,
    KYA_REGISTRY: kyaRegistry,
    CREDIT_FACILITY: creditFacility,
    ...(kept ? keptEnv(kept) : {}),
  });
  const names = kept ? ["CashEthSwapVMRouter", "CashEthTaker"] : ["AquaRouter", "CashEthSwapVMRouter", "CashEthOrderBuilder", "TestStablecoin", "CashEthTaker"];
  const missing = names.filter((n) => !created.has(n));
  if (missing.length > 0 || calls.length > 0) {
    throw new Error(`03_DeployAqua: missing ${missing.join(", ") || "none"}, unexpected calls ${calls.length}`);
  }
  const get = async (n: string) => withBlock(created.get(n)!);
  return {
    aqua: kept?.aqua ?? (await get("AquaRouter")),
    swapRouter: await get("CashEthSwapVMRouter"),
    orderBuilder: kept?.orderBuilder ?? (await get("CashEthOrderBuilder")),
    tUsdt: kept?.tUsdt ?? (await get("TestStablecoin")),
    taker: await get("CashEthTaker"),
  };
}

// ------------------------------------------------------------------ 2. wire

async function wire(d: Deploy): Promise<NonNullable<C4State["wiring"]>> {
  console.log("2. wire: rcn.wire and facility.wire (one-time, from the operator)");
  const swapRouter = d.swapRouter.address;
  const aqua = d.aqua.address;
  if (!isAddressEqual(await read(rcn, ReceivableCreditNoteAbi, "facility"), ZERO)) {
    throw new Error("rcn is already wired but c4.json has no wiring record");
  }
  if (!isAddressEqual(await read(creditFacility, CreditFacilityAbi, "swapRouter"), ZERO)) {
    throw new Error("facility is already wired but c4.json has no wiring record");
  }
  const rcnTx = await send("ReceivableCreditNote.wire(facility, repaymentRouter, swapRouter, aqua)", {
    address: rcn,
    abi: ReceivableCreditNoteAbi,
    functionName: "wire",
    args: [creditFacility, repaymentRouter, swapRouter, aqua],
  });
  const facilityTx = await send("CreditFacility.wire(swapRouter, repaymentRouter)", {
    address: creditFacility,
    abi: CreditFacilityAbi,
    functionName: "wire",
    args: [swapRouter, repaymentRouter],
  });
  return { rcn: rcnTx, facility: facilityTx };
}

// ------------------------------------------------------------------ 3. mint

function lender(prefix: "LENDER_A" | "LENDER_B" | "LENDER_C"): Address {
  return getAddress(need(`${prefix}_EVM`, env[`${prefix}_EVM`]));
}

const MINT_TARGETS = ["LENDER_A", "LENDER_B", "LENDER_C", "operator (trader)"] as const;

/** Appends each mint record to the state as it lands, so a relay timeout never loses a recorded mint. */
async function mints(s: C4State): Promise<void> {
  console.log("3. mint: 50 tUSDT to lenders A/B/C, 20 to the operator (trader)");
  const tUsdt = s.deploy!.tUsdt.address;
  s.tUsdtMints ??= [];
  for (const label of MINT_TARGETS) {
    if (s.tUsdtMints.some((m) => m.label === label)) continue;
    const [to, target] = label === "operator (trader)" ? [operator, 20n * TUSDT_UNIT] : [lender(label), 50n * TUSDT_UNIT];
    s.tUsdtMints.push(await mintTo(tUsdt, label, to, target));
    writeC4(s);
  }
}

// ------------------------------------------------------------------ 4. verify

function expectEq(label: string, actual: string | bigint | number, expected: string | bigint | number, out: Record<string, string>): void {
  const same =
    typeof actual === "string" && typeof expected === "string" && actual.startsWith("0x") && expected.startsWith("0x")
      ? isAddressEqual(actual as Address, expected as Address)
      : String(actual) === String(expected);
  if (!same) throw new Error(`${label} = ${actual}, expected ${expected}`);
  out[label] = String(actual);
  console.log(`  ${label} = ${actual}`);
}

async function verify(s: C4State): Promise<Record<string, string>> {
  console.log("4. verify: wiring getters, immutables, owners, tUSDT and the taker's USDC association");
  const d = s.deploy!;
  const router = d.swapRouter.address;
  const aqua = d.aqua.address;
  const out: Record<string, string> = {};

  expectEq("rcn.facility()", await read(rcn, ReceivableCreditNoteAbi, "facility"), creditFacility, out);
  expectEq("rcn.repaymentRouter()", await read(rcn, ReceivableCreditNoteAbi, "repaymentRouter"), repaymentRouter, out);
  expectEq("rcn.swapRouter()", await read(rcn, ReceivableCreditNoteAbi, "swapRouter"), router, out);
  expectEq("rcn.aqua()", await read(rcn, ReceivableCreditNoteAbi, "aqua"), aqua, out);
  expectEq("facility.swapRouter()", await read(creditFacility, CreditFacilityAbi, "swapRouter"), router, out);
  expectEq(
    "facility.repaymentRouter()",
    await read(creditFacility, CreditFacilityAbi, "repaymentRouter"),
    repaymentRouter,
    out,
  );

  expectEq("aqua.owner()", await read(aqua, AquaRouterAbi, "owner"), operator, out);
  expectEq("swapRouter.AQUA()", await read(router, CashEthSwapVMRouterAbi, "AQUA"), aqua, out);
  expectEq("swapRouter.REGISTRY()", await read(router, CashEthSwapVMRouterAbi, "REGISTRY"), receivableRegistry, out);
  expectEq("swapRouter.KYA()", await read(router, CashEthSwapVMRouterAbi, "KYA"), kyaRegistry, out);
  expectEq("swapRouter.FACILITY()", await read(router, CashEthSwapVMRouterAbi, "FACILITY"), creditFacility, out);
  expectEq("swapRouter.owner()", await read(router, CashEthSwapVMRouterAbi, "owner"), operator, out);
  const domain = await read<readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]]>(
    router,
    CashEthSwapVMRouterAbi,
    "eip712Domain",
  );
  expectEq("swapRouter.eip712Domain().name", domain[1], "CashETH SwapVM", out);
  expectEq("swapRouter.eip712Domain().version", domain[2], "1.0.0", out);
  expectEq("swapRouter.eip712Domain().chainId", domain[3], 296n, out);
  // The router's WETH immutable is internal; the constructor argument is recorded here for reference.
  out["swapRouter weth (constructor arg)"] = WHBAR;

  expectEq("tUsdt.symbol()", await read(d.tUsdt.address, TestStablecoinAbi, "symbol"), "tUSDT", out);
  expectEq("tUsdt.decimals()", await read(d.tUsdt.address, TestStablecoinAbi, "decimals"), 6, out);
  expectEq("tUsdt.owner()", await read(d.tUsdt.address, TestStablecoinAbi, "owner"), operator, out);
  for (const m of s.tUsdtMints ?? []) {
    const bal = await read<bigint>(d.tUsdt.address, TestStablecoinAbi, "balanceOf", [m.to]);
    out[`tUsdt.balanceOf(${m.label})`] = bal.toString();
    console.log(`  tUsdt.balanceOf(${m.label}) = ${bal}`);
  }

  expectEq("taker.owner()", await read(d.taker.address, CashEthTakerAbi, "owner"), operator, out);
  expectEq("taker.ROUTER()", await read(d.taker.address, CashEthTakerAbi, "ROUTER"), router, out);
  expectEq("taker.USDC()", await read(d.taker.address, CashEthTakerAbi, "USDC"), usdc, out);
  const rel = await mirror.waitFor(() =>
    mirrorGet<{ tokens: { token_id: string }[] }>(`/accounts/${d.taker.contractId}/tokens?token.id=${env.USDC_TOKEN_ID}`),
  );
  if (!rel.tokens.some((t) => t.token_id === env.USDC_TOKEN_ID)) throw new Error("taker is not associated with USDC");
  out["taker USDC association"] = `${d.taker.contractId} <-> ${env.USDC_TOKEN_ID}`;
  console.log(`  taker ${d.taker.contractId} associated with USDC ${env.USDC_TOKEN_ID}`);
  return out;
}

// ------------------------------------------------------------------ main

const state = readC4(operator);
if (state.deploy) console.log(`1. deploy: done (aqua ${state.deploy.aqua.address}, router ${state.deploy.swapRouter.address})`);
else {
  state.deploy = await deploy(state.kept);
  writeC4(state);
}
if (state.wiring) console.log("2. wire: done");
else {
  state.wiring = await wire(state.deploy);
  writeC4(state);
}
if (MINT_TARGETS.every((l) => state.tUsdtMints?.some((m) => m.label === l))) console.log("3. mint: done");
else await mints(state);
state.verified = await verify(state);
writeC4(state);

const d = state.deploy;
const updated: Addresses = {
  ...addresses,
  aqua: d.aqua.address,
  swapRouter: d.swapRouter.address,
  orderBuilder: d.orderBuilder.address,
  tUsdt: d.tUsdt.address,
  taker: d.taker.address,
  deployedBlock: d.aqua.block,
};
writeJson(ADDRESSES_FILE, updated);

console.log("\nC4 deploy summary");
for (const [label, c] of Object.entries(d)) {
  console.log(`  ${label.padEnd(12)} ${c.address} ${hashscan.contract(c.contractId)} block ${c.block} (deploy ${c.tx.hashscan}, gas used ${c.gas.used})`);
}
for (const step of [state.wiring.rcn, state.wiring.facility]) console.log(`  ${step.label}: ${step.hashscan}`);
for (const m of state.tUsdtMints ?? []) console.log(`  mint ${m.label}: ${m.tx?.hashscan ?? "already funded"}`);
console.log(`  addresses: ${ADDRESSES_FILE}`);
