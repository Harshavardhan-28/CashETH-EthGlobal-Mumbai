/** Test-only in-memory orchestrator, access-token minting and app factory (excluded from the build). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AquaAddresses, LenderStrategy, Plan } from "@casheth/aqua";
import { EventStore, IdempotencyLedger } from "@casheth/engine";
import { computeReceivableId, ReceivableRegistryAbi } from "@casheth/shared";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { decodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { createVerifier } from "../auth.js";
import { ToolError } from "../orchestrator/errors.js";
import { PendingStore } from "../orchestrator/pending.js";
import type {
  AgentStats,
  AquaPort,
  BudgetView,
  Calldata,
  ChainAddresses,
  ChainPort,
  FacilityInfoView,
  FundPlan,
  FundResult,
  KyaAgent,
  LenderYield,
  Orchestrator,
  PaymentRequirements,
  ReceivableView,
  Reputation,
  ReservationView,
  Signer,
  StatsProvider,
  TransferSummary,
  X402Port,
} from "../orchestrator/types.js";
import { createMcpApp } from "../server.js";

export const ISSUER = new URL("http://localhost:4020");
export const RESOURCE = new URL("http://localhost:4030/mcp");
export const ZERO32 = `0x${"0".repeat(64)}` as Hex;
export const NOW = 1_800_000_000n;

export const ADDRS: ChainAddresses = {
  chainId: 296,
  kyaRegistry: getAddress("0x00000000000000000000000000000000000000a1"),
  receivableRegistry: getAddress("0x00000000000000000000000000000000000000a2"),
  creditFacility: getAddress("0x00000000000000000000000000000000000000a3"),
  repaymentRouter: getAddress("0x00000000000000000000000000000000000000a4"),
  usdc: getAddress("0x0000000000000000000000000000000000068cda"),
};

const ZERO_ADDR = getAddress("0x0000000000000000000000000000000000000000");

export function kyaAgent(level: number, role: number, group: string): KyaAgent {
  return { uaidHash: ZERO32, ownerGroup: keccak256(toHex(group)), role, level, expiresAt: 0n, revoked: false, mandateHash: ZERO32 };
}

export function budget(over: Partial<BudgetView> = {}): BudgetView {
  return { alloc: 0n, spent: 0n, reserved: 0n, maxPerTx: 0n, maxDaily: 0n, dailySpent: 0n, dayStart: 0n, ...over };
}

const k = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");

/** In-memory chain: reads from maps; `send` records the call and applies `register` / `reserve` / `commit`. */
export class FakeChain implements ChainPort {
  timestamp = NOW;
  agents = new Map<string, KyaAgent>();
  reps = new Map<string, Reputation>();
  receivables = new Map<string, ReceivableView>();
  nonces = new Map<string, bigint>();
  facilities = new Map<string, FacilityInfoView>();
  budgets = new Map<string, BudgetView>();
  merchantLists = new Map<string, Address[]>();
  reservations = new Map<string, ReservationView>();
  balances = new Map<string, bigint>();
  available_ = 0n;
  held = new Set<string>();
  sent: { from: Signer; call: Calldata }[] = [];
  /** Throws this error code from the next `send` (a contract revert). */
  revertNext: string | undefined;
  #tx = 0;

  addresses(): ChainAddresses {
    return ADDRS;
  }
  async latestTimestamp() {
    return this.timestamp;
  }
  async kyaAgent(a: Address) {
    return this.agents.get(k(a)) ?? kyaAgent(0, 0, "none");
  }
  async reputation(a: Address) {
    return this.reps.get(k(a)) ?? { onTime: 0, late: 0, defaults: 0 };
  }
  async receivableState(id: Hex) {
    return this.receivables.get(k(id))?.state ?? 0;
  }
  async receivable(id: Hex): Promise<ReceivableView> {
    return (
      this.receivables.get(k(id)) ?? {
        seller: ZERO_ADDR,
        buyer: ZERO_ADDR,
        currency: ZERO_ADDR,
        amount: 0n,
        dueDate: 0n,
        detailsCommitment: ZERO32,
        state: 0,
        registeredAt: 0n,
      }
    );
  }
  async buyerNonce(buyer: Address) {
    return this.nonces.get(k(buyer)) ?? 0n;
  }
  async facilityInfo(id: Hex): Promise<FacilityInfoView> {
    return (
      this.facilities.get(k(id)) ?? {
        seller: ZERO_ADDR,
        buyer: ZERO_ADDR,
        receivableAmount: 0n,
        dueDate: 0n,
        funded: 0n,
        committed: 0n,
        reserved: 0n,
        status: 0,
      }
    );
  }
  async makers() {
    return [] as Address[];
  }
  async position() {
    return { principal: 0n, aprBps: 0, start: 0n, paidPrincipal: 0n, paidFee: 0n };
  }
  async available() {
    return this.available_;
  }
  async budget(id: Hex, worker: Address) {
    return this.budgets.get(k(id, worker)) ?? budget();
  }
  async merchants(id: Hex, worker: Address) {
    return this.merchantLists.get(k(id, worker)) ?? [];
  }
  async reservation(spendId: Hex): Promise<ReservationView> {
    return (
      this.reservations.get(k(spendId)) ?? {
        id: ZERO32,
        worker: ZERO_ADDR,
        spendWallet: ZERO_ADDR,
        merchant: ZERO_ADDR,
        amount: 0n,
        expiry: 0n,
        status: 0,
        txIdHash: ZERO32,
      }
    );
  }
  async openReservationOf() {
    return ZERO32;
  }
  async paused() {
    return false;
  }
  async lenderDue() {
    return 0n;
  }
  async dueOf() {
    return { principal: 0n, fee: 0n };
  }
  async usdcBalance(a: Address) {
    return this.balances.get(k(a)) ?? 0n;
  }
  holdsKey(agent: Address) {
    return this.held.has(k(agent));
  }
  async send(from: Signer, call: Calldata) {
    if (this.revertNext) {
      const code = this.revertNext;
      this.revertNext = undefined;
      throw new ToolError(code, `reverted ${code}`);
    }
    this.sent.push({ from, call });
    if (call.to === ADDRS.receivableRegistry) {
      const { functionName, args } = decodeFunctionData({ abi: ReceivableRegistryAbi, data: call.data });
      if (functionName === "register") {
        const [c] = args as unknown as [{ seller: Address; buyer: Address; currency: Address; amount: bigint; dueDate: bigint; buyerRef: Hex; detailsCommitment: Hex }];
        const id = computeReceivableId(c.buyer, c.buyerRef);
        this.receivables.set(k(id), {
          seller: c.seller,
          buyer: c.buyer,
          currency: c.currency,
          amount: c.amount,
          dueDate: c.dueDate,
          detailsCommitment: c.detailsCommitment,
          state: 1,
          registeredAt: this.timestamp,
        });
        this.nonces.set(k(c.buyer), (this.nonces.get(k(c.buyer)) ?? 0n) + 1n);
      }
    }
    this.#tx += 1;
    return { txHash: keccak256(toHex(`tx${this.#tx}`)) };
  }
}

export const AQUA_ADDRS: AquaAddresses = {
  aqua: getAddress("0x00000000000000000000000000000000000000b1"),
  swapRouter: getAddress("0x00000000000000000000000000000000000000b2"),
  orderBuilder: getAddress("0x00000000000000000000000000000000000000b3"),
  usdc: ADDRS.usdc,
  rcn: getAddress("0x00000000000000000000000000000000000000b4"),
};

export class FakeAqua implements AquaPort {
  strategies: LenderStrategy[] = [];
  plan: Plan = { fills: [], total: 0n, skipped: [] };
  addresses() {
    return AQUA_ADDRS;
  }
  async discover() {
    return { strategies: this.strategies, skipped: [] };
  }
  async solve() {
    return this.plan;
  }
  async fund(_lender: Address, _plan: FundPlan, _inProcess: boolean): Promise<FundResult> {
    return { mode: "calldata", calls: [], credit: { strategyHash: ZERO32 } };
  }
  async dock() {
    return { mode: "calldata" as const, calls: [] };
  }
}

/**
 * Fake x402: `pay` builds the requirements a merchant would send (`payTo`, amount) and a transfer that pays them
 * from the spend wallet, then calls `cosign` like the real client does.
 */
export class FakeX402 implements X402Port {
  accounts = new Map<string, string>();
  requirements: PaymentRequirements = { scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", payTo: "0.0.9001", amount: "250000" };
  cosigned: string[] = [];
  async accountIdOf(evm: Address) {
    const id = this.accounts.get(evm.toLowerCase());
    if (!id) throw new Error(`unknown account ${evm}`);
    return id;
  }
  decodeTransfer(txBase64: string): TransferSummary {
    return JSON.parse(Buffer.from(txBase64, "base64").toString("utf8"), (_k, v: unknown) =>
      typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as TransferSummary;
  }
  async cosignerSign(txBase64: string) {
    this.cosigned.push(txBase64);
    return txBase64;
  }
  async pay(p: { spendWalletId: string; cosign: (tx: string, r: PaymentRequirements) => Promise<string> }) {
    const amount = BigInt(this.requirements.amount);
    const summary = {
      tokenTransfers: [
        { tokenId: this.requirements.asset, accountId: p.spendWalletId, amount: `${-amount}n` },
        { tokenId: this.requirements.asset, accountId: this.requirements.payTo, amount: `${amount}n` },
      ],
      hbarTransfers: [],
    };
    await p.cosign(Buffer.from(JSON.stringify(summary)).toString("base64"), this.requirements);
    return { status: 200, body: { ok: true }, transactionId: "0.0.5005@1800000000.000000001" };
  }
}

export class FakeStats implements StatsProvider {
  agents: AgentStats[] = [];
  lenders: LenderYield[] = [];
  async listAgents() {
    return this.agents;
  }
  async agentStats(address: Address) {
    const a = this.agents.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!a) throw new ToolError("NOT_FOUND", "unknown agent");
    return a;
  }
  async listLenders() {
    return this.lenders;
  }
  async lenderYield(address: Address) {
    const l = this.lenders.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!l) throw new ToolError("NOT_FOUND", "unknown lender");
    return l;
  }
}

export type TestOrchestrator = Orchestrator & {
  chain: FakeChain;
  aqua: FakeAqua;
  x402: FakeX402;
  stats: FakeStats;
  hcsPublished: Record<string, unknown>[];
  hcsFail: { on: boolean };
  minted: { id: Hex; hcsSeq: number }[];
};

export function fakeOrchestrator(): TestOrchestrator {
  const dir = mkdtempSync(join(tmpdir(), "casheth-mcp-"));
  const hcsPublished: Record<string, unknown>[] = [];
  const hcsFail = { on: false };
  const minted: { id: Hex; hcsSeq: number }[] = [];
  return {
    chain: new FakeChain(),
    aqua: new FakeAqua(),
    x402: new FakeX402(),
    stats: new FakeStats(),
    hcs: {
      topicId: "0.0.7777",
      async publish(message) {
        if (hcsFail.on) throw new Error("mirror hiccup");
        hcsPublished.push(message);
        return { sequenceNumber: hcsPublished.length, txId: `0.0.1@1800000000.${String(hcsPublished.length).padStart(9, "0")}` };
      },
    },
    nft: {
      tokenId: "0.0.8888",
      async mint(p) {
        minted.push(p);
        return { serial: minted.length, txId: "0.0.1@1800000001.000000000" };
      },
    },
    explainer: { explain: async () => undefined },
    identity: { uaid: async (p) => `uaid:aid:test;uid=${p.accountId}` },
    events: new EventStore(join(dir, "events.jsonl")),
    idempotency: new IdempotencyLedger(join(dir, "idempotency.json")),
    pending: new PendingStore(),
    config: { x402Network: "hedera:testnet", usdcTokenId: "0.0.429274", explorer: "testnet" },
    now: () => NOW,
    log: () => undefined,
    hcsPublished,
    hcsFail,
    minted,
  };
}

/** A locally generated authorization-server key and a token minter with the auth server's claim shape. */
export async function testIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: "ES256", kid: "test-kid", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return { privateKey, jwks, mint: (claims: TokenClaims = {}) => mintToken(privateKey, claims) };
}

export type TokenClaims = {
  agent?: Address;
  role?: number;
  level?: number;
  scope?: string;
  aud?: string;
  iss?: string;
  expSeconds?: number;
  sub?: string;
};

async function mintToken(key: CryptoKey, c: TokenClaims): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({
    agent: c.agent ?? getAddress("0x00000000000000000000000000000000000000c1"),
    role: c.role ?? 1,
    kya_level: c.level ?? 2,
    owner_group: keccak256(toHex("owner:test")),
    scope: c.scope ?? "receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read",
  })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "test-kid" })
    .setIssuer(c.iss ?? ISSUER.href)
    .setSubject(c.sub ?? "uaid:aid:test")
    .setAudience(c.aud ?? RESOURCE.href)
    .setJti(crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + (c.expSeconds ?? 600))
    .sign(key);
}

export const OAUTH_METADATA = {
  issuer: ISSUER.href,
  authorization_endpoint: new URL("/authorize", ISSUER).href,
  token_endpoint: new URL("/token", ISSUER).href,
  response_types_supported: ["code"],
};

export async function testApp(o: Orchestrator = fakeOrchestrator()) {
  const issuer = await testIssuer();
  const app = createMcpApp({
    orchestrator: o,
    resource: RESOURCE,
    oauthMetadata: OAUTH_METADATA,
    verifier: createVerifier({ issuer: ISSUER, resource: RESOURCE, jwks: issuer.jwks }),
    corsOrigins: ["http://localhost:3000"],
  });
  return { app, o, issuer };
}
