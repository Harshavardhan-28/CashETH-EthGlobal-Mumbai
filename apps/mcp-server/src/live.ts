/**
 * Real implementations of the orchestrator ports: viem on the Hedera JSON-RPC relay (contract reads, simulated
 * and receipted writes), the mirror node (account ids, contract logs), the Hiero SDK (HCS audit, NFT mint),
 * `@casheth/aqua` (discovery, solver, ship/dock) and `@casheth/hedera` (co-signed x402). Contract addresses are
 * read from `deployments/testnet/addresses.json` on every use, so contracts deployed after boot are picked up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AquaProtocolContract, Address as SdkAddress, HexString } from "@1inch/aqua-sdk";
import {
  buildBaseYieldOrder,
  buildLenderOrder,
  discoverStrategies,
  dockStrategy,
  shipBaseYield,
  shipLenderStrategy,
  solve,
  type AquaAddresses,
  type LenderWallet,
} from "@casheth/aqua";
import { EventStore, IdempotencyLedger } from "@casheth/engine";
import {
  addSignature,
  buildUaid,
  createCosignedHederaSigner,
  createX402Fetch,
  evmClients,
  hieroClient,
  mintReceivableNft,
  decodeMirrorKey,
  mirror,
  payX402,
  PrivateKey,
  publishAudit,
  storeFile,
  type AuditEvent as HcsAuditEvent,
  type DecodedKey,
} from "@casheth/hedera";
import {
  AquaRouterAbi,
  CashEthSwapVMRouterAbi,
  CreditFacilityAbi,
  DEMO_ACCOUNTS,
  isErrorCode,
  KYARegistryAbi,
  loadAddresses,
  ReceivableRegistryAbi,
  RepaymentRouterAbi,
  type Env,
} from "@casheth/shared";
import { Transaction } from "@hiero-ledger/sdk";
import {
  BaseError,
  decodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hexKey, type AgentKeyRole, type McpConfig } from "./config.js";
import { createInvoiceExtractor, resolveLlm } from "./invoices/extract.js";
import { InvoiceStore } from "./invoices/store.js";
import { ToolError } from "./orchestrator/errors.js";
import { createAnthropicExplainer } from "./orchestrator/explain.js";
import { PendingStore } from "./orchestrator/pending.js";
import { enqueue } from "./orchestrator/queue.js";
import type { SpendWalletPort } from "./orchestrator/spendWallets.js";
import { BasicStatsProvider } from "./orchestrator/stats.js";
import type {
  AgentDirectoryEntry,
  AgentRoleName,
  AquaPort,
  Calldata,
  ChainAddresses,
  ChainPort,
  FundPlan,
  FundResult,
  LogSource,
  Orchestrator,
  RawLog,
  Signer,
  TransferSummary,
  X402Port,
} from "./orchestrator/types.js";

/** Every custom error our contracts (and Aqua/SwapVM) can revert with, for decoding simulated reverts. */
const ERRORS_ABI = [
  ...KYARegistryAbi,
  ...ReceivableRegistryAbi,
  ...CreditFacilityAbi,
  ...RepaymentRouterAbi,
  ...CashEthSwapVMRouterAbi,
  ...AquaRouterAbi,
  ...erc20Abi,
].filter((e) => e.type === "error") as Abi;

function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const hit = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && String((e as { data: string }).data).startsWith("0x"));
  const data = (hit as { data?: string } | null)?.data;
  return data && data.length >= 10 ? (data as Hex) : undefined;
}

/**
 * A failed simulation as a ToolError: a custom error with a shared name keeps that name as the code (the
 * contracts revert with the shared error codes), any other decodable custom error becomes `CONTRACT_REVERTED`
 * with `error: <name>`, and anything else `CHAIN_ERROR`.
 */
export function toToolError(err: unknown, call: Calldata): ToolError {
  const data = revertData(err);
  if (data) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: ERRORS_ABI, data });
      const details = args?.length ? { args: args.map(String) } : {};
      const message = `${call.description} reverted ${errorName}`;
      return isErrorCode(errorName) ? new ToolError(errorName, message, details) : new ToolError("CONTRACT_REVERTED", message, { error: errorName, ...details });
    } catch {
      // unknown selector: fall through
    }
  }
  const message = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  return new ToolError("CHAIN_ERROR", `${call.description} failed: ${message}`);
}

type AgentKey = { prefix: string; key: Hex; address: Address; accountId?: string };

/** Demo agent keys from `.env.accounts` (`<PREFIX>_KEY`), indexed by the EVM address their key controls. */
function agentKeys(env: Env): AgentKey[] {
  const prefixes = [...new Set([...DEMO_ACCOUNTS, "LENDER_D"])];
  const out: AgentKey[] = [];
  for (const prefix of prefixes) {
    const raw = env[`${prefix}_KEY`];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const key = hexKey(raw.trim());
    const id = env[`${prefix}_ID`];
    out.push({ prefix, key, address: privateKeyToAccount(key).address, ...(typeof id === "string" && id ? { accountId: id } : {}) });
  }
  return out;
}

/** The agent role a demo account prefix signs as; server accounts (coordinator, co-signer, issuer) have none. */
function agentKeyRole(prefix: string): AgentKeyRole | undefined {
  if (prefix === "SELLER") return "seller";
  if (prefix === "BUYER") return "buyer";
  if (prefix.startsWith("WORKER_")) return "worker";
  return undefined;
}

/** Whether the server may sign with this demo account's key (`AGENT_KEYS_IN_PROCESS`, `LENDER_KEYS_IN_PROCESS`). */
export function inProcessAllowed(prefix: string, cfg: Pick<McpConfig, "agentKeyRoles" | "lenderKeysInProcess">): boolean {
  if (prefix.startsWith("LENDER_")) return cfg.lenderKeysInProcess;
  const role = agentKeyRole(prefix);
  return role !== undefined && cfg.agentKeyRoles.includes(role);
}

function mirrorBase(env: Env): string {
  return `${env.HEDERA_MIRROR_NODE_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}/api/v1`;
}

async function mirrorGet<T>(env: Env, pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : pathOrUrl.startsWith("/api/v1") ? `${mirrorBase(env).replace(/\/api\/v1$/, "")}${pathOrUrl}` : `${mirrorBase(env)}${pathOrUrl}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mirror node ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** All logs of a contract from the mirror node (no block-range limit, consensus timestamps included). */
export function mirrorLogSource(env: Env): LogSource {
  return {
    async logs(address: Address): Promise<RawLog[]> {
      const out: RawLog[] = [];
      let next: string | null = `/contracts/${address}/results/logs?order=asc&limit=100`;
      for (let page = 0; next && page < 200; page++) {
        const body: {
          logs: { address: string; data: string | null; topics: string[]; timestamp: string; transaction_hash: string }[];
          links?: { next?: string | null };
        } = await mirrorGet(env, next);
        for (const l of body.logs) {
          out.push({
            address: getAddress(l.address),
            data: (l.data ?? "0x") as Hex,
            topics: l.topics as Hex[],
            timestamp: Math.floor(Number(l.timestamp)),
            txHash: l.transaction_hash as Hex,
          });
        }
        next = body.links?.next ?? null;
      }
      return out;
    },
  };
}

export function createLiveChain(env: Env, cfg: McpConfig, keys: AgentKey[]): ChainPort {
  const { public: pub, chain } = evmClients(env);
  /** One transaction in flight per signing key, so concurrent tool calls never race for a nonce. */
  const sendQueues = new Map<Hex, Promise<unknown>>();
  const wallets = new Map<string, WalletClient>();
  const walletFor = (key: Hex): WalletClient => {
    let w = wallets.get(key);
    if (!w) {
      w = evmClients(env, key).wallet!;
      wallets.set(key, w);
    }
    return w;
  };
  const addresses = (): ChainAddresses => {
    const a = loadAddresses();
    const need = <K extends "kyaRegistry" | "receivableRegistry" | "creditFacility" | "repaymentRouter" | "usdc">(k: K): Address => {
      const v = a[k];
      if (!v) throw new ToolError("NOT_DEPLOYED", `deployments/testnet/addresses.json has no ${k} yet`);
      return v;
    };
    return {
      chainId: a.chainId,
      kyaRegistry: need("kyaRegistry"),
      receivableRegistry: need("receivableRegistry"),
      creditFacility: need("creditFacility"),
      repaymentRouter: need("repaymentRouter"),
      usdc: need("usdc"),
    };
  };
  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> =>
    pub.readContract({ address, abi, functionName, args }) as Promise<T>;
  const keyOf = (from: Signer): Hex => {
    if (from === "coordinator") return cfg.coordinatorKey;
    if (from === "issuer") {
      if (!cfg.kyaIssuerKey) throw new ToolError("KEY_NOT_HELD", "KYA_ISSUER_KEY is not configured");
      return cfg.kyaIssuerKey;
    }
    const k = keys.find((x) => x.address.toLowerCase() === from.agent.toLowerCase());
    if (!k || !inProcessAllowed(k.prefix, cfg)) throw new ToolError("KEY_NOT_HELD", `the server does not sign for ${from.agent}`);
    return k.key;
  };

  return {
    addresses,
    async latestTimestamp() {
      return (await pub.getBlock({ blockTag: "latest" })).timestamp;
    },
    async kyaAgent(account) {
      const a = await read<{ uaidHash: Hex; ownerGroup: Hex; role: number; level: number; expiresAt: bigint; revoked: boolean; mandateHash: Hex }>(
        addresses().kyaRegistry,
        KYARegistryAbi as Abi,
        "agent",
        [account],
      );
      return { ...a };
    },
    async reputation(account) {
      const [onTime, late, defaults] = await read<[number, number, number]>(addresses().kyaRegistry, KYARegistryAbi as Abi, "reputation", [account]);
      return { onTime, late, defaults };
    },
    async receivableState(id) {
      return Number(await read<number>(addresses().receivableRegistry, ReceivableRegistryAbi as Abi, "state", [id]));
    },
    async receivable(id) {
      const r = await read<{
        seller: Address;
        buyer: Address;
        currency: Address;
        amount: bigint;
        dueDate: bigint;
        detailsCommitment: Hex;
        state: number;
        registeredAt: bigint;
      }>(addresses().receivableRegistry, ReceivableRegistryAbi as Abi, "get", [id]);
      return { ...r, state: Number(r.state) };
    },
    buyerNonce(buyer) {
      return read<bigint>(addresses().receivableRegistry, ReceivableRegistryAbi as Abi, "nonces", [buyer]);
    },
    async facilityInfo(id) {
      const f = await read<{
        seller: Address;
        buyer: Address;
        receivableAmount: bigint;
        dueDate: bigint;
        funded: bigint;
        committed: bigint;
        reserved: bigint;
        status: number;
      }>(addresses().creditFacility, CreditFacilityAbi as Abi, "facilityInfo", [id]);
      return { ...f, status: Number(f.status) };
    },
    async makers(id) {
      return [...(await read<readonly Address[]>(addresses().creditFacility, CreditFacilityAbi as Abi, "makers", [id]))];
    },
    async position(id, maker) {
      const p = await read<{ principal: bigint; aprBps: number; start: bigint; paidPrincipal: bigint; paidFee: bigint }>(
        addresses().creditFacility,
        CreditFacilityAbi as Abi,
        "position",
        [id, maker],
      );
      return { ...p };
    },
    available(id) {
      return read<bigint>(addresses().creditFacility, CreditFacilityAbi as Abi, "available", [id]);
    },
    async budget(id, worker) {
      const b = await read<{ alloc: bigint; spent: bigint; reserved: bigint; maxPerTx: bigint; maxDaily: bigint; dailySpent: bigint; dayStart: bigint }>(
        addresses().creditFacility,
        CreditFacilityAbi as Abi,
        "budget",
        [id, worker],
      );
      return { ...b, dayStart: BigInt(b.dayStart) };
    },
    async merchants(id, worker) {
      return [...(await read<readonly Address[]>(addresses().creditFacility, CreditFacilityAbi as Abi, "merchants", [id, worker]))];
    },
    async reservation(spendId) {
      const r = await read<{
        id: Hex;
        worker: Address;
        spendWallet: Address;
        merchant: Address;
        amount: bigint;
        expiry: bigint;
        status: number;
        txIdHash: Hex;
      }>(addresses().creditFacility, CreditFacilityAbi as Abi, "reservation", [spendId]);
      return { ...r, expiry: BigInt(r.expiry), status: Number(r.status) };
    },
    openReservationOf(spendWallet) {
      return read<Hex>(addresses().creditFacility, CreditFacilityAbi as Abi, "openReservationOf", [spendWallet]);
    },
    paused() {
      return read<boolean>(addresses().creditFacility, CreditFacilityAbi as Abi, "paused");
    },
    lenderDue(id) {
      return read<bigint>(addresses().repaymentRouter, RepaymentRouterAbi as Abi, "lenderDue", [id]);
    },
    async dueOf(id, maker) {
      const [principal, fee] = await read<[bigint, bigint]>(addresses().repaymentRouter, RepaymentRouterAbi as Abi, "dueOf", [id, maker]);
      return { principal, fee };
    },
    usdcBalance(account) {
      return read<bigint>(addresses().usdc, erc20Abi as Abi, "balanceOf", [account]);
    },
    holdsKey(agent) {
      const k = keys.find((x) => x.address.toLowerCase() === agent.toLowerCase());
      return !!k && inProcessAllowed(k.prefix, cfg);
    },
    async signTypedData(agent, typedData) {
      if (!this.holdsKey(agent)) throw new ToolError("KEY_NOT_HELD", `the server does not hold the key for ${agent} (AGENT_KEYS_IN_PROCESS)`);
      const wallet = walletFor(keyOf({ agent }));
      return wallet.signTypedData({ ...typedData, account: wallet.account! } as Parameters<WalletClient["signTypedData"]>[0]);
    },
    send(from, call) {
      const key = keyOf(from);
      return enqueue(sendQueues, key, async () => {
        const wallet = walletFor(key);
        const account = wallet.account!;
        let gas: bigint;
        try {
          await pub.call({ account, to: call.to, data: call.data });
          gas = ((await pub.estimateGas({ account, to: call.to, data: call.data })) * 13n) / 10n;
        } catch (err) {
          throw toToolError(err, call);
        }
        const hash = await wallet.sendTransaction({ account, chain, to: call.to, data: call.data, gas });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new ToolError("CHAIN_ERROR", `${call.description} reverted on-chain (${hash})`, { txHash: hash });
        return { txHash: hash };
      });
    },
  };
}

/**
 * `token.approve(spender, current allowance + add)`: an exact amount, never "max" (HTS rejects unlimited
 * approvals), raised by what the new strategy needs on top of the open ones.
 */
export async function exactApprovalCall(
  reader: Pick<PublicClient, "readContract">,
  p: { token: Address; owner: Address; spender: Address; add: bigint; label: string },
): Promise<Calldata> {
  const current = await reader.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.owner, p.spender] });
  return {
    to: p.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [p.spender, current + p.add] }),
    description: `${p.label}.approve(Aqua, current allowance + ${p.add}) (exact: HTS rejects unlimited approvals)`,
  };
}

/** `Aqua.ship(app = swap router, strategy, amounts)` calldata. */
function shipCall(addrs: AquaAddresses, strategy: Hex, tokens: { token: Address; amount: bigint }[], description: string): Calldata {
  const tx = new AquaProtocolContract(new SdkAddress(addrs.aqua)).ship({
    app: new SdkAddress(addrs.swapRouter),
    strategy: new HexString(strategy),
    amountsAndTokens: tokens.map(({ token, amount }) => ({ token: new SdkAddress(token), amount })),
  });
  return { to: getAddress(String(tx.to)), data: String(tx.data) as Hex, description };
}

/**
 * The lender-signed transactions of `fund_agents`, in order: USDC (and tUSDT) approvals to Aqua, then the credit
 * and base `ship` calls. Allowances are raised additively (current allowance + what the new strategies ship), as
 * the `@casheth/aqua` ship helpers do, so the lender's already open strategies keep their allowance.
 */
export async function fundCalldata(
  reader: Pick<PublicClient, "readContract">,
  addrs: AquaAddresses,
  lender: Address,
  plan: FundPlan,
): Promise<Extract<FundResult, { mode: "calldata" }>> {
  const tUsdt = plan.base ? addrs.tUsdt : undefined;
  if (plan.base && !tUsdt) throw new ToolError("NOT_DEPLOYED", "addresses.json has no tUsdt: base-yield strategies need the test stablecoin");
  const credit = await buildLenderOrder(reader, addrs.orderBuilder, { maker: lender, rcn: addrs.rcn, usdc: addrs.usdc, args: plan.args, salt: plan.salt });
  const base =
    plan.base && tUsdt
      ? await buildBaseYieldOrder(reader, addrs.orderBuilder, { maker: lender, usdc: addrs.usdc, tUsdt, feeBps: plan.base.feeBps, salt: plan.salt })
      : undefined;

  const calls: Calldata[] = [
    await exactApprovalCall(reader, { token: addrs.usdc, owner: lender, spender: addrs.aqua, add: plan.creditUsdc + (plan.base?.usdc ?? 0n), label: "USDC" }),
  ];
  if (plan.base && tUsdt) calls.push(await exactApprovalCall(reader, { token: tUsdt, owner: lender, spender: addrs.aqua, add: plan.base.tUsdt, label: "tUSDT" }));
  calls.push(
    shipCall(addrs, credit.strategy, [
      { token: addrs.usdc, amount: plan.creditUsdc },
      { token: addrs.rcn, amount: 0n },
    ], "Aqua.ship(credit strategy over USDC/RCN)"),
  );
  if (base && plan.base && tUsdt) {
    calls.push(
      shipCall(addrs, base.strategy, [
        { token: addrs.usdc, amount: plan.base.usdc },
        { token: tUsdt, amount: plan.base.tUsdt },
      ], "Aqua.ship(base-yield strategy over USDC/tUSDT)"),
    );
  }
  return {
    mode: "calldata",
    calls,
    credit: { strategyHash: keccak256(credit.strategy) },
    ...(base ? { base: { strategyHash: keccak256(base.strategy) } } : {}),
  };
}

/** The first block worth scanning for Aqua logs: config, addresses.json, or the swap router's creation block. */
async function aquaFromBlock(env: Env, cfg: McpConfig, swapRouter: Address): Promise<bigint> {
  if (cfg.aquaFromBlock !== undefined) return cfg.aquaFromBlock;
  const a = loadAddresses() as Record<string, unknown>;
  for (const k of ["aquaFromBlock", "deployedBlock"]) if (typeof a[k] === "number") return BigInt(a[k] as number);
  const c = await mirrorGet<{ created_timestamp?: string }>(env, `/contracts/${swapRouter}`);
  if (!c.created_timestamp) return 0n;
  const blocks = await mirrorGet<{ blocks: { number: number }[] }>(env, `/blocks?timestamp=lte:${c.created_timestamp}&order=desc&limit=1`);
  return BigInt(blocks.blocks[0]?.number ?? 0);
}

export function createLiveAqua(env: Env, cfg: McpConfig, keys: AgentKey[]): AquaPort {
  const { public: pub } = evmClients(env);
  let fromBlock: { router: Address; block: Promise<bigint> } | undefined;
  const addresses = (): AquaAddresses => {
    const a = loadAddresses();
    const missing = (["aqua", "swapRouter", "orderBuilder", "usdc", "rcn"] as const).filter((k) => !a[k]);
    if (missing.length) throw new ToolError("NOT_DEPLOYED", `deployments/testnet/addresses.json has no ${missing.join(", ")} yet`);
    return { aqua: a.aqua!, swapRouter: a.swapRouter!, orderBuilder: a.orderBuilder!, usdc: a.usdc!, rcn: a.rcn!, ...(a.tUsdt ? { tUsdt: a.tUsdt } : {}) };
  };
  const lenderWallet = (lender: Address): LenderWallet => {
    const k = keys.find((x) => x.address.toLowerCase() === lender.toLowerCase());
    if (!k || !k.prefix.startsWith("LENDER_") || !cfg.lenderKeysInProcess) throw new ToolError("KEY_NOT_HELD", `the server does not sign for ${lender}`);
    return evmClients(env, k.key).wallet as LenderWallet;
  };
  return {
    addresses,
    async discover() {
      const addrs = addresses();
      if (!fromBlock || fromBlock.router !== addrs.swapRouter) fromBlock = { router: addrs.swapRouter, block: aquaFromBlock(env, cfg, addrs.swapRouter) };
      return discoverStrategies(pub as PublicClient, addrs, { fromBlock: await fromBlock.block });
    },
    solve(input) {
      return solve(pub as PublicClient, addresses(), { ...input, coordinator: privateKeyToAccount(cfg.coordinatorKey).address });
    },
    async fund(lender: Address, plan: FundPlan, inProcess: boolean): Promise<FundResult> {
      const addrs = addresses();
      if (plan.base && !addrs.tUsdt) throw new ToolError("NOT_DEPLOYED", "addresses.json has no tUsdt: base-yield strategies need the test stablecoin");
      if (inProcess) {
        // shipLenderStrategy / shipBaseYield raise each allowance to Aqua by exactly the shipped amount.
        const wallet = lenderWallet(lender);
        const credit = await shipLenderStrategy(wallet, addrs, { args: plan.args, salt: plan.salt, usdcAmount: plan.creditUsdc });
        const base = plan.base
          ? await shipBaseYield(wallet, addrs, { usdcAmount: plan.base.usdc, tUsdtAmount: plan.base.tUsdt, feeBps: plan.base.feeBps, salt: plan.salt })
          : undefined;
        return {
          mode: "shipped",
          credit: { strategyHash: credit.strategyHash, txHash: credit.txHash },
          ...(base ? { base: { strategyHash: base.strategyHash, txHash: base.txHash } } : {}),
        };
      }
      return fundCalldata(pub, addrs, lender, plan);
    },
    async dock(lender, p, inProcess) {
      const addrs = addresses();
      if (inProcess) {
        const { txHash } = await dockStrategy(lenderWallet(lender), addrs.aqua, { app: addrs.swapRouter, strategyHash: p.strategyHash, tokens: p.tokens });
        return { mode: "sent", txHash };
      }
      const tx = new AquaProtocolContract(new SdkAddress(addrs.aqua)).dock({
        app: new SdkAddress(addrs.swapRouter),
        strategyHash: new HexString(p.strategyHash),
        tokens: p.tokens.map((t) => new SdkAddress(t)),
      });
      return { mode: "calldata", calls: [{ to: getAddress(String(tx.to)), data: String(tx.data) as Hex, description: "Aqua.dock(strategy)" }] };
    },
  };
}

/** `0x000…00<num>` long-zero addresses map straight to `0.0.<num>`; anything else is looked up on the mirror. */
export function longZeroAccountId(evm: Address): string | undefined {
  const hex = evm.slice(2).toLowerCase();
  return /^0{24}/.test(hex) ? `0.0.${BigInt(`0x${hex.slice(24)}`)}` : undefined;
}

export function createLiveX402(env: Env, cfg: McpConfig, keys: AgentKey[]): X402Port {
  const cosigner = PrivateKey.fromStringECDSA(cfg.cosignerKey);
  const cache = new Map<string, string>();
  return {
    async accountIdOf(evm) {
      const direct = longZeroAccountId(evm);
      if (direct) return direct;
      const hit = cache.get(evm.toLowerCase());
      if (hit) return hit;
      const { account } = await mirror.account(env, evm);
      cache.set(evm.toLowerCase(), account);
      return account;
    },
    decodeTransfer(txBase64): TransferSummary {
      const tx = Transaction.fromBytes(Buffer.from(txBase64, "base64")) as Transaction & {
        tokenTransfers?: Iterable<[{ toString(): string }, Iterable<[{ toString(): string }, { toString(): string }]>]>;
        hbarTransfers?: Iterable<[{ toString(): string }, { toTinybars(): { toString(): string } }]>;
      };
      const tokenTransfers: TransferSummary["tokenTransfers"] = [];
      for (const [tokenId, accounts] of tx.tokenTransfers ?? []) {
        for (const [accountId, amount] of accounts) tokenTransfers.push({ tokenId: tokenId.toString(), accountId: accountId.toString(), amount: BigInt(amount.toString()) });
      }
      const hbarTransfers: TransferSummary["hbarTransfers"] = [];
      for (const [accountId, hbar] of tx.hbarTransfers ?? []) hbarTransfers.push({ accountId: accountId.toString(), amount: BigInt(hbar.toTinybars().toString()) });
      const payer = tx.transactionId?.accountId?.toString();
      return { ...(payer ? { payerAccountId: payer } : {}), tokenTransfers, hbarTransfers };
    },
    cosignerSign(txBase64) {
      return addSignature(txBase64, cosigner);
    },
    async pay({ worker, spendWalletId, url, cosign }) {
      const k = keys.find((x) => x.address.toLowerCase() === worker.toLowerCase());
      if (!k || !k.prefix.startsWith("WORKER_") || !inProcessAllowed(k.prefix, cfg)) {
        throw new ToolError("KEY_NOT_HELD", `the server does not hold the worker key for ${worker} (set AGENT_KEYS_IN_PROCESS=worker or true for the demo)`);
      }
      const signer = createCosignedHederaSigner({
        accountId: spendWalletId,
        workerKey: PrivateKey.fromStringECDSA(k.key),
        network: cfg.x402Network,
        cosign: (tx, requirements) => cosign(tx, requirements),
      });
      return payX402(createX402Fetch(signer), url);
    },
  };
}

const SPEND_WALLETS_PATH = fileURLToPath(new URL("../../../deployments/testnet/spend-wallets.json", import.meta.url));

/** Account ids of the registered spend wallets (`scripts/c5-spend-wallets.ts`), read on every call. */
function registeredSpendWalletIds(): Set<string> {
  if (!existsSync(SPEND_WALLETS_PATH)) return new Set();
  const file = JSON.parse(readFileSync(SPEND_WALLETS_PATH, "utf8")) as { wallets?: Record<string, { accountId?: string }> };
  return new Set(Object.values(file.wallets ?? {}).flatMap((w) => (w.accountId ? [w.accountId] : [])));
}

/** Memoises `load(key)` for the process lifetime; a failed lookup is forgotten so the next call retries. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load().catch((err: unknown) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, hit);
  }
  return hit;
}

/** Registered spend wallets with their mirror-node keys, and agent public keys, both cached per account. */
export function createLiveSpendWallets(env: Env, cfg: McpConfig): SpendWalletPort {
  const walletKeys = new Map<string, Promise<DecodedKey | undefined>>();
  const agentPublicKeys = new Map<string, Promise<string | undefined>>();
  return {
    cosignerPublicKey: PrivateKey.fromStringECDSA(cfg.cosignerKey).publicKey.toStringRaw(),
    async registeredKey(spendWallet) {
      const accountId = longZeroAccountId(spendWallet);
      if (!accountId || !registeredSpendWalletIds().has(accountId)) return undefined;
      return memo(walletKeys, accountId, async () => {
        const { key } = await mirror.account(env, accountId);
        return key ? decodeMirrorKey(key) : undefined;
      });
    },
    publicKeyOf(account) {
      return memo(agentPublicKeys, account.toLowerCase(), async () => {
        const { key } = await mirror.account(env, account);
        return key?._type === "ECDSA_SECP256K1" ? key.key : undefined;
      });
    },
  };
}

const ROLE_BY_PREFIX: Record<string, AgentRoleName> = {
  SELLER: "seller",
  BUYER: "buyer",
  WORKER_RESEARCH: "worker",
  WORKER_COMPUTE: "worker",
  LENDER_A: "lender",
  LENDER_B: "lender",
  LENDER_C: "lender",
  LENDER_D: "lender",
};

/** `WORKER_RESEARCH` -> `workerResearch` (the labels `scripts/c2-register-demo.ts` uses). */
function labelOf(prefix: string): string {
  return prefix.toLowerCase().replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Demo agents with their HCS-14 UAIDs (built offline from the account ids). */
export async function demoDirectory(env: Env, keys: AgentKey[]): Promise<AgentDirectoryEntry[]> {
  const out: AgentDirectoryEntry[] = [];
  for (const prefix of Object.keys(ROLE_BY_PREFIX)) {
    const k = keys.find((x) => x.prefix === prefix);
    const evm = env[`${prefix}_EVM`];
    const address = k?.address ?? (typeof evm === "string" && evm ? getAddress(evm) : undefined);
    const accountId = k?.accountId ?? (typeof env[`${prefix}_ID`] === "string" ? String(env[`${prefix}_ID`]) : undefined);
    if (!address) continue;
    const role = ROLE_BY_PREFIX[prefix]!;
    const label = labelOf(prefix);
    const known = env[`${prefix}_UAID`];
    const uaid =
      typeof known === "string" && known
        ? known
        : accountId
          ? (await buildUaid({ evmAddress: address, accountId, name: label, role, network: "hedera:testnet" })).uaid
          : "";
    out.push({ address, label, role, uaid });
  }
  return out;
}

export async function createLiveOrchestrator(env: Env, cfg: McpConfig): Promise<Orchestrator> {
  const keys = agentKeys(env);
  const chain = createLiveChain(env, cfg, keys);
  const aqua = createLiveAqua(env, cfg, keys);
  const events = new EventStore(join(cfg.dataDir, "events.jsonl"));
  const hiero = hieroClient(env);
  const directory = await demoDirectory(env, keys);
  const log = (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg: message, ...fields }));
  const llm = await resolveLlm({ ...(cfg.llmProvider ? { provider: cfg.llmProvider } : {}), baseUrl: cfg.ollamaBaseUrl, model: cfg.llmModel });
  log("invoice extraction", { extractor: llm ? `ollama (${llm.model})` : "heuristic" });
  return {
    chain,
    aqua,
    x402: createLiveX402(env, cfg, keys),
    spendWallets: createLiveSpendWallets(env, cfg),
    hcs: {
      topicId: cfg.hcsTopicId,
      async publish(message) {
        return publishAudit(hiero, cfg.hcsTopicId!, message as HcsAuditEvent);
      },
    },
    nft: {
      tokenId: cfg.nftTokenId,
      mint: (p) => mintReceivableNft(hiero, cfg.nftTokenId!, p),
    },
    explainer: cfg.anthropicApiKey ? createAnthropicExplainer(cfg.anthropicApiKey) : { explain: async () => undefined },
    stats: new BasicStatsProvider({
      chain,
      aqua,
      logs: mirrorLogSource(env),
      events,
      directory: () => directory,
      now: () => Math.floor(Date.now() / 1000),
    }),
    identity: {
      async uaid(p) {
        return (await buildUaid({ evmAddress: p.evmAddress, accountId: p.accountId, name: p.name, role: p.role, network: "hedera:testnet" })).uaid;
      },
    },
    events,
    idempotency: new IdempotencyLedger(join(cfg.dataDir, "idempotency.json")),
    pending: new PendingStore(join(cfg.dataDir, "pending.json")),
    invoices: new InvoiceStore(join(cfg.dataDir, "invoices")),
    extractor: createInvoiceExtractor({ ...(llm ? { llm } : {}), log }),
    ...(cfg.hfsEnabled ? { hfs: { store: (bytes: Uint8Array, memo: string) => storeFile(hiero, bytes, memo) } } : {}),
    config: { x402Network: cfg.x402Network, usdcTokenId: cfg.usdcTokenId, explorer: "testnet", merchantOrigins: cfg.merchantOrigins, ...(cfg.sellerWorker ? { sellerWorker: cfg.sellerWorker } : {}) },
    now: () => BigInt(Math.floor(Date.now() / 1000)),
    log,
  };
}
