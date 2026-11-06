/** Wires the real agents, Hedera clients and read API into a `DemoContext` from the environment. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { listOpenStrategies } from "@casheth/aqua";
import { evmClients, hieroClient, longZeroEvmAddress, mirror, transferUsdc } from "@casheth/hedera";
import { loadAddresses, type Env } from "@casheth/shared";
import { erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBuyerAgent } from "../buyer.js";
import { agentKitFromEnv } from "../kit.js";
import { createLenderAgent } from "../lender.js";
import { consoleLog, type Log } from "../log.js";
import { AgentClient } from "../mcpClient.js";
import { createSellerAgent } from "../seller.js";
import { walletCallSender, type AgentWallet } from "../sendCalls.js";
import { createWorkerAgent } from "../worker.js";
import { INVOICE } from "./plan.js";
import { addressOf, loadIdentity, type AgentIdentity, type AgentPrefix } from "./identity.js";
import { createReadApi } from "./readApi.js";
import { mcpResourceUrl, merchantPort } from "./servers.js";
import type { DemoContext, DemoWorker } from "./types.js";

const run = promisify(execFile);
/** Quotes and funding scan every lender strategy on a relay that is sometimes slow: allow ten minutes per tool call. */
const CALL_TIMEOUT_MS = 600_000;
const HEDERA_TX_ID = /^\d+\.\d+\.\d+@\d+\.\d+$/;

interface SpendWalletRecord {
  accountId: string;
  evmAddress: Address;
}

/** The registered 2-of-2 spend wallets (`deployments/testnet/spend-wallets.json`). */
function readSpendWallets(root: string): Record<"research" | "compute", SpendWalletRecord> {
  const file = JSON.parse(readFileSync(`${root}deployments/testnet/spend-wallets.json`, "utf8")) as { wallets: Record<string, SpendWalletRecord> };
  const pick = (name: string): SpendWalletRecord => {
    const wallet = file.wallets[name];
    if (!wallet) throw new Error(`deployments/testnet/spend-wallets.json has no ${name}`);
    return wallet;
  };
  return { research: pick("SPEND_WALLET_RESEARCH"), compute: pick("SPEND_WALLET_COMPUTE") };
}

export async function buildContext(env: Env, root: string, log: Log = consoleLog): Promise<DemoContext> {
  const mcpUrl = mcpResourceUrl(env);

  const connect = async (prefix: AgentPrefix) => {
    const identity = await loadIdentity(env, prefix);
    const client = AgentClient.connect({ agentKey: identity.key, uaid: identity.uaid, role: identity.role, mandateHash: identity.mandateHash, mcpUrl, callTimeoutMs: CALL_TIMEOUT_MS });
    return { identity, client };
  };
  const sender = (identity: AgentIdentity) => walletCallSender(evmClients(env, identity.key).wallet as AgentWallet);

  const [seller, buyer, workerResearch, workerCompute, lenderA, lenderB] = await Promise.all(
    (["SELLER", "BUYER", "WORKER_RESEARCH", "WORKER_COMPUTE", "LENDER_A", "LENDER_B"] as const).map(connect),
  );
  const spendWallets = readSpendWallets(root);
  const catalogUrls = [`http://localhost:${merchantPort(env)}/catalog`];

  const worker = (agent: typeof workerResearch, wallet: SpendWalletRecord, kitPrefix: "WORKER_RESEARCH" | "WORKER_COMPUTE"): DemoWorker => ({
    address: agent.identity.address,
    spendWallet: wallet.evmAddress,
    agent: createWorkerAgent({ client: agent.client, worker: agent.identity.address, spendWallet: wallet.evmAddress, catalogUrls, log }),
    kit: agentKitFromEnv(env, kitPrefix),
  });
  const lender = ({ identity, client }: typeof lenderA) => ({ address: identity.address, accountId: identity.accountId, agent: createLenderAgent({ client, send: sender(identity) }) });

  const hiero = hieroClient(env);
  const evm = evmClients(env);
  const usdcBalance = (address: Address): Promise<bigint> =>
    evm.public.readContract({ address: env.USDC_EVM_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] });

  return {
    log,
    invoice: {
      buyer: buyer.identity.address,
      amount: INVOICE.amount,
      dueDate: INVOICE.dueDate,
      buyerRef: INVOICE.buyerRef,
    },
    invoiceFile: INVOICE.file,
    seller: { address: seller.identity.address, accountId: seller.identity.accountId, agent: createSellerAgent(seller.client, sender(seller.identity)), kit: agentKitFromEnv(env, "SELLER") },
    buyer: { address: buyer.identity.address, accountId: buyer.identity.accountId, agent: createBuyerAgent({ client: buyer.client, account: privateKeyToAccount(buyer.identity.key), send: sender(buyer.identity) }) },
    research: worker(workerResearch, spendWallets.research, "WORKER_RESEARCH"),
    compute: worker(workerCompute, spendWallets.compute, "WORKER_COMPUTE"),
    lenders: { A: lender(lenderA), B: lender(lenderB) },
    makers: { A: lenderA.identity.address, B: lenderB.identity.address, C: addressOf(env, "LENDER_C"), D: addressOf(env, "LENDER_D") },
    merchant: longZeroEvmAddress(env.MERCHANT_ACCOUNT_ID) as Address,
    read: createReadApi(new URL(mcpUrl).origin),
    usdcBalance,
    async openStrategies() {
      const { aqua, swapRouter, orderBuilder, usdc, rcn, tUsdt } = loadAddresses();
      if (!aqua || !swapRouter || !orderBuilder || !usdc || !rcn) throw new Error("deployments/testnet/addresses.json lacks the Aqua contracts");
      const fromBlock = await mirror.creationBlock(env, swapRouter);
      return listOpenStrategies(evm.public, { aqua, swapRouter, orderBuilder, usdc, rcn, ...(tUsdt ? { tUsdt } : {}) }, { fromBlock });
    },
    async topUpFromOperator(accountId, units) {
      const held = await mirror.tokenBalance(env, env.HEDERA_OPERATOR_ID, env.USDC_TOKEN_ID);
      if (held < units) throw new Error(`the operator holds ${held} USDC units, ${units} are needed; fund it from https://faucet.circle.com (Hedera Testnet)`);
      return transferUsdc(hiero, { tokenId: env.USDC_TOKEN_ID, from: env.HEDERA_OPERATOR_ID, fromKey: env.HEDERA_OPERATOR_KEY, to: accountId, units });
    },
    async resolveTx(ref) {
      if (HEDERA_TX_ID.test(ref)) return ref;
      return (await mirror.waitFor(() => mirror.txByHash(env, ref as Hex))).transactionId;
    },
    async verifyInvoiceDocument(id) {
      try {
        const { stdout } = await run("pnpm", ["tsx", "scripts/c9-invoice-verify.ts", id], { cwd: root, env: { ...process.env, MCP_BASE_URL: new URL(mcpUrl).origin } });
        return stdout;
      } catch (error) {
        // A MISMATCH exits non-zero but prints its verdict: hand that to the step, which fails on it.
        const { stdout } = error as { stdout?: string };
        if (stdout) return stdout;
        throw error;
      }
    },
    poll: { attempts: 8, delayMs: 3000 },
    state: {},
  };
}
