/**
 * Starts anvil, deploys the full CashETH stack with contracts/script/LocalStack.s.sol, installs MockHSS at the
 * Hedera Schedule Service address 0x16b, and registers one buyer-confirmed receivable (signed here with
 * `signReceivableConfirmation`). Provides the addresses to the tests as `inject("localStack")` and writes them
 * to a JSON file. Nothing here touches a real network.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { computeReceivableId, ReceivableRegistryAbi, receivableDomain, signReceivableConfirmation } from "@casheth/shared";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toHex, type Address, type Hex } from "viem";
import type { TestProject } from "vitest/node";
import { account, ANVIL_PORT, ANVIL_RPC, anvilChain, type LocalStack } from "./localStack.js";

const run = promisify(execFile);
const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
/** Address the facility calls for schedules (hard-coded in CreditFacility). */
const HSS = "0x000000000000000000000000000000000000016b";
const RECEIVABLE_AMOUNT = 8_000_000n; // 8 USDC: a 7500 bps advance is 6 USDC
const DAY = 86_400n;

/** First directory whose `forge --version` is Foundry's (the PATH may hold an unrelated `forge`). */
async function foundryBin(): Promise<string> {
  const candidates = [process.env.FOUNDRY_BIN, join(homedir(), ".foundry", "bin"), ""].filter(
    (d): d is string => d !== undefined,
  );
  for (const dir of candidates) {
    const forge = dir ? join(dir, "forge") : "forge";
    try {
      const { stdout } = await run(forge, ["--version"]);
      if (stdout.includes("forge Version")) return dir;
    } catch {
      // not here
    }
  }
  throw new Error("Foundry not found: set FOUNDRY_BIN to the directory holding Foundry's forge and anvil");
}

const bin = (dir: string, name: string) => (dir ? join(dir, name) : name);

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(ANVIL_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function startAnvil(dir: string): Promise<ChildProcess> {
  if (await rpcUp()) throw new Error(`port ${ANVIL_PORT} is already serving JSON-RPC; stop that node first`);
  const child = spawn(bin(dir, "anvil"), ["--port", String(ANVIL_PORT), "--chain-id", "31337", "--silent"], {
    stdio: "ignore",
  });
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code) => reject(new Error(`anvil exited early with code ${code}`))),
  );
  exited.catch(() => undefined);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await Promise.race([rpcUp(), exited])) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("anvil did not come up within 20 s");
}

async function deployStack(dir: string): Promise<Record<string, Address>> {
  const pk = toHex(account("deployer").getHdKey().privateKey!);
  const lenders = (["lenderA", "lenderB", "lenderC", "lenderD"] as const).map((r) => account(r).address);
  const { stdout } = await run(
    bin(dir, "forge"),
    ["script", "script/LocalStack.s.sol", "--tc", "LocalStack", "--rpc-url", ANVIL_RPC, "--private-key", pk, "--broadcast"],
    {
      cwd: CONTRACTS,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        LOCAL_COORDINATOR: account("coordinator").address,
        LOCAL_SELLER: account("seller").address,
        LOCAL_BUYER: account("buyer").address,
        LOCAL_WORKER_RESEARCH: account("workerResearch").address,
        LOCAL_LENDERS: lenders.join(","),
      },
    },
  );
  const out: Record<string, Address> = {};
  for (const m of stdout.matchAll(/LOCALSTACK (\w+) (0x[0-9a-fA-F]{40})/g)) out[m[1]!] = getAddress(m[2]!);
  if (!stdout.includes("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL")) {
    throw new Error(`LocalStack.s.sol did not broadcast:\n${stdout.slice(-2000)}`);
  }
  return out;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await foundryBin();
  const anvil = await startAnvil(dir);
  const teardown = async () => {
    anvil.kill();
  };
  try {
    const a = await deployStack(dir);
    const required = [
      "aqua", "usdc", "tUsdt", "kyaRegistry", "receivableRegistry", "rcn", "creditFacility",
      "repaymentRouter", "swapRouter", "orderBuilder", "mockHss",
    ];
    for (const k of required) if (!a[k]) throw new Error(`LocalStack.s.sol printed no ${k}`);

    const transport = http(ANVIL_RPC);
    const pub = createPublicClient({ chain: anvilChain, transport });

    // CreditFacility calls the schedule service at the hard-coded 0x16b; anvil can place code there directly.
    const hssCode = await pub.getCode({ address: a.mockHss! });
    await pub.request({ method: "anvil_setCode" as never, params: [HSS, hssCode] as never });

    // One buyer-confirmed receivable: the buyer signs EIP-712, the seller submits.
    const seller = account("seller");
    const buyer = account("buyer");
    const registry = a.receivableRegistry!;
    const { timestamp } = await pub.getBlock();
    const buyerRef = keccak256(toHex("PO-LOCAL-1"));
    const message = {
      seller: seller.address,
      buyer: buyer.address,
      currency: a.usdc!,
      amount: RECEIVABLE_AMOUNT,
      dueDate: timestamp + 30n * DAY,
      buyerRef,
      detailsCommitment: keccak256(toHex("local invoice")),
      payTo: a.repaymentRouter!,
      nonce: await pub.readContract({ address: registry, abi: ReceivableRegistryAbi, functionName: "nonces", args: [buyer.address] }),
      deadline: timestamp + 3_600n,
    };
    const signature = await signReceivableConfirmation(buyer, receivableDomain(anvilChain.id, registry), message);
    const wallet = createWalletClient({ account: seller, chain: anvilChain, transport });
    const hash = await wallet.writeContract({
      address: registry,
      abi: ReceivableRegistryAbi,
      functionName: "register",
      args: [message, signature],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("receivable registration reverted");
    const id: Hex = computeReceivableId(buyer.address, buyerRef);
    const state = await pub.readContract({ address: registry, abi: ReceivableRegistryAbi, functionName: "state", args: [id] });
    if (state !== 1) throw new Error(`receivable ${id} is in state ${state}, expected Confirmed (1)`);

    const path = join(mkdtempSync(join(tmpdir(), "casheth-localstack-")), "stack.json");
    const stack: LocalStack = {
      rpc: ANVIL_RPC,
      chainId: anvilChain.id,
      aqua: a.aqua!,
      usdc: a.usdc!,
      tUsdt: a.tUsdt!,
      kyaRegistry: a.kyaRegistry!,
      receivableRegistry: registry,
      rcn: a.rcn!,
      creditFacility: a.creditFacility!,
      repaymentRouter: a.repaymentRouter!,
      swapRouter: a.swapRouter!,
      orderBuilder: a.orderBuilder!,
      mockHss: a.mockHss!,
      deployedBlock: String(await pub.getBlockNumber()),
      receivable: {
        id,
        seller: seller.address,
        buyer: buyer.address,
        amount: String(RECEIVABLE_AMOUNT),
        dueDate: String(message.dueDate),
      },
      path,
    };
    writeFileSync(path, `${JSON.stringify(stack, null, 2)}\n`);
    project.provide("localStack", stack);
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
