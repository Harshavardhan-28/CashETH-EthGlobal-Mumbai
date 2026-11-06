import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { longZeroEvmAddress } from "@casheth/hedera";
import { ROLES } from "@casheth/shared";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { AgentClient, ToolCallError, type ToolCaller } from "./mcpClient.js";
import { createWorkerAgent, pickOffer, PurchaseError } from "./worker.js";
import { budget, NOW, startStack, type Stack } from "./test/stack.js";

const facilityId = keccak256(toHex("receivable-1"));
const worker: Address = getAddress("0x00000000000000000000000000000000000000d1");
const spendWallet: Address = getAddress("0x0000000000000000000000000000000000ad06dc");
const SPEND_ID = keccak256(toHex("spend-1"));
const TX_ID = "0.0.5005@1800000000.000000001";

const offer = (name: string, price: string, payTo: string, catalog = "https://a.example/catalog") => ({
  name,
  url: `${catalog.replace("/catalog", "")}/${name}?topic=`,
  method: "GET",
  price,
  asset: "0.0.429274",
  decimals: 6,
  network: "hedera-testnet",
  payTo,
});

/** Serves each catalog URL's services as the merchant's `/catalog` JSON. */
const catalogFetch =
  (catalogs: Record<string, ReturnType<typeof offer>[]>): typeof fetch =>
  async (input) => {
    const services = catalogs[String(input)];
    return services ? Response.json({ services }) : new Response("not found", { status: 404 });
  };

const CATALOGS = {
  "https://a.example/catalog": [offer("research", "0.30", "0.0.9001"), offer("compute", "5.50", "0.0.9001")],
  "https://b.example/catalog": [offer("research", "0.25", "0.0.9002", "https://b.example/catalog")],
};
const catalogUrls = Object.keys(CATALOGS);

describe("pickOffer", () => {
  it("compares prices as integer units across catalogs and picks the cheapest", async () => {
    const chosen = await pickOffer(catalogUrls, "research", catalogFetch(CATALOGS));
    expect(chosen).toMatchObject({ price: "0.25", payTo: "0.0.9002", catalog: "https://b.example/catalog" });
  });

  it("throws when no catalog offers the service", async () => {
    await expect(pickOffer(catalogUrls, "translation", catalogFetch(CATALOGS))).rejects.toThrow(/no offer for "translation"/);
  });
});

function setup(responses: Record<string, unknown | Error>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: ToolCaller = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      const response = responses[tool];
      if (response instanceof Error) throw response;
      return response as never;
    },
  };
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const agent = createWorkerAgent({ client, worker, spendWallet, catalogUrls, fetch: catalogFetch(CATALOGS), log: (message, fields) => logs.push({ message, fields }) });
  return { agent, calls, logs };
}

const reserved = { id: facilityId, spendId: SPEND_ID, amount: "250000", expiry: 1_800_000_600, txHash: "0xaa" };

describe("workerAgent.buy", () => {
  it("reserves the cheapest offer, pays its URL and commits the payment's transaction id", async () => {
    const { agent, calls } = setup({
      reserve_spend: reserved,
      pay_x402: { spendId: SPEND_ID, transactionId: TX_ID, status: 200, body: {} },
      commit_spend: { spendId: SPEND_ID, txHash: "0xbb" },
    });
    const outcome = await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1", query: "hedera x402" });

    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402", "commit_spend"]);
    expect(calls[0]!.args).toMatchObject({
      id: facilityId,
      worker,
      spendWallet,
      merchant: longZeroEvmAddress("0.0.9002"),
      amount: "250000",
    });
    expect(calls[1]!.args).toMatchObject({ spendId: SPEND_ID, url: "https://b.example/research?topic=hedera%20x402" });
    expect(calls[2]!.args).toMatchObject({ spendId: SPEND_ID, hederaTxId: TX_ID });
    expect(outcome).toMatchObject({ status: "committed", spendId: SPEND_ID, transactionId: TX_ID, price: 250_000n });
  });

  it("derives one distinct key per step from the receivable, service and purchaseId", async () => {
    const happy = { reserve_spend: reserved, pay_x402: { spendId: SPEND_ID, transactionId: TX_ID }, commit_spend: {} };
    const keysOf = async (purchaseId: string, service = "research") => {
      const { agent, calls } = setup(happy);
      await agent.buy({ id: facilityId, service, budgetHint: 500_000n, purchaseId });
      return calls.map((c) => c.args.idempotencyKey as string);
    };
    const first = await keysOf("p-1");
    expect(await keysOf("p-1")).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(first.every((k) => k.length >= 8 && k.length <= 128)).toBe(true);
    expect((await keysOf("p-2")).filter((k) => first.includes(k))).toEqual([]);
    expect((await keysOf("p-1", "compute")).filter((k) => first.includes(k))).toEqual([]);
  });

  it("buying again with the same purchaseId replays the server's stored results and pays once", async () => {
    const effects: string[] = [];
    const ledger = new Map<string, unknown>();
    const results: Record<string, unknown> = {
      reserve_spend: reserved,
      pay_x402: { spendId: SPEND_ID, transactionId: TX_ID },
      commit_spend: {},
    };
    // Like the MCP server: the first call per (tool, key) runs, a repeat returns the stored result.
    const client: ToolCaller = {
      call: async (tool, args) => {
        const key = `${tool}:${String(args.idempotencyKey)}`;
        if (!ledger.has(key)) {
          effects.push(tool);
          ledger.set(key, results[tool]);
        }
        return ledger.get(key) as never;
      },
    };
    const agent = createWorkerAgent({ client, worker, spendWallet, catalogUrls, fetch: catalogFetch(CATALOGS), log: () => undefined });
    const request = { id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" };
    const first = await agent.buy(request);
    const second = await agent.buy(request);
    expect(second).toEqual(first);
    expect(effects).toEqual(["reserve_spend", "pay_x402", "commit_spend"]);
    await agent.buy({ ...request, purchaseId: "p-2" });
    expect(effects).toHaveLength(6);
  });

  it("still asks the server when the price is above the budget hint: the engine decides", async () => {
    const { agent, calls, logs } = setup({ reserve_spend: new ToolCallError("reserve_spend", { code: "AGENT_BUDGET_EXCEEDED", stage: "engine" }) });
    const outcome = await agent.buy({ id: facilityId, service: "compute", budgetHint: 3_000_000n, purchaseId: "p-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.amount).toBe("5500000");
    expect(logs.map((l) => l.message)).toContain("price is above the budget hint; the control plane decides");
    expect(outcome).toEqual({ status: "rejected", stage: "reserve", code: "AGENT_BUDGET_EXCEEDED" });
  });

  it("logs the error code and stops without paying when the reservation is rejected", async () => {
    const { agent, calls, logs } = setup({ reserve_spend: new ToolCallError("reserve_spend", { code: "TX_LIMIT_EXCEEDED" }) });
    const outcome = await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" });
    expect(outcome).toEqual({ status: "rejected", stage: "reserve", code: "TX_LIMIT_EXCEEDED" });
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend"]);
    expect(logs.at(-1)).toMatchObject({ message: "spend rejected", fields: { stage: "reserve", code: "TX_LIMIT_EXCEEDED" } });
  });

  it("does not retry or commit when the co-signer refuses the payment", async () => {
    const { agent, calls } = setup({
      reserve_spend: reserved,
      pay_x402: new ToolCallError("pay_x402", { code: "COSIGNER_REFUSED", reason: "wrong_payee" }),
    });
    const outcome = await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" });
    expect(outcome).toEqual({ status: "rejected", stage: "pay", code: "COSIGNER_REFUSED" });
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402"]);
  });

  it("surfaces the spend id and settlement tx id when the commit is rejected after a settled payment", async () => {
    const { agent, logs } = setup({
      reserve_spend: reserved,
      pay_x402: { spendId: SPEND_ID, transactionId: TX_ID },
      commit_spend: new ToolCallError("commit_spend", { code: "RESERVATION_EXPIRED" }),
    });
    expect(await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" })).toEqual({
      status: "paid_uncommitted",
      spendId: SPEND_ID,
      transactionId: TX_ID,
      reason: "RESERVATION_EXPIRED",
    });
    expect(logs.at(-1)).toMatchObject({ message: "spend rejected", fields: { stage: "commit", code: "RESERVATION_EXPIRED" } });
  });

  it("surfaces the same ids when the commit fails with a transport error", async () => {
    const { agent } = setup({
      reserve_spend: reserved,
      pay_x402: { spendId: SPEND_ID, transactionId: TX_ID },
      commit_spend: new Error("socket hang up"),
    });
    expect(await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" })).toEqual({
      status: "paid_uncommitted",
      spendId: SPEND_ID,
      transactionId: TX_ID,
      reason: "socket hang up",
    });
  });

  it("lets a transport failure before the reservation propagate as is", async () => {
    const { agent } = setup({ reserve_spend: new Error("socket hang up") });
    await expect(agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" })).rejects.toThrow("socket hang up");
  });

  it("names the reservation when the payment call fails with a transport error", async () => {
    const { agent } = setup({ reserve_spend: reserved, pay_x402: new Error("socket hang up") });
    const error = await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.spendId).toBe(SPEND_ID);
    expect(error.message).toContain("socket hang up");
  });

  it("names the reservation when the payment settled without a transaction id", async () => {
    const { agent, calls } = setup({ reserve_spend: reserved, pay_x402: { spendId: SPEND_ID, status: 200 } });
    const error = await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(PurchaseError);
    expect(error.spendId).toBe(SPEND_ID);
    expect(error.message).toMatch(/no transaction id/);
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402"]);
  });
});

describe("workerAgent.buy from an external x402 merchant (casheth-paid-apis)", () => {
  const PAID_APIS = "https://paid.example.run.app/";
  const PAYEE = "0.0.11333304";
  const paidApis = {
    network: "hedera:testnet",
    asset: { id: "0.0.429274", symbol: "USDC", decimals: 6 },
    services: [
      { method: "GET", path: "/price-feed", price: "$0.50", payTo: PAYEE, example: "/price-feed?symbols=HBAR,ETH,BTC" },
      { method: "POST", path: "/llm-summary", price: "$2.00", payTo: PAYEE, example: 'POST /llm-summary {"text": "..."}' },
      { method: "GET", path: "/premium-data", price: "$5.00", payTo: "0.0.6666", example: "/premium-data" },
    ],
  };
  const fetchPaidApis: typeof fetch = async (input) =>
    String(input) === PAID_APIS ? Response.json(paidApis) : new Response("not found", { status: 404 });

  function externalSetup(responses: Record<string, unknown | Error>) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client: ToolCaller = {
      call: async (tool, args) => {
        calls.push({ tool, args });
        const response = responses[tool];
        if (response instanceof Error) throw response;
        return response as never;
      },
    };
    const agent = createWorkerAgent({ client, worker, spendWallet, catalogUrls: [PAID_APIS], fetch: fetchPaidApis, log: () => undefined });
    return { agent, calls };
  }

  const paid = { reserve_spend: reserved, pay_x402: { spendId: SPEND_ID, transactionId: TX_ID, status: 200, body: {} }, commit_spend: {} };
  const request = { id: facilityId, service: "price-feed", budgetHint: 500_000n, purchaseId: "p-1" };

  it("reserves 0.50 USDC for the merchant's payee and pays /price-feed?symbols=HBAR", async () => {
    const { agent, calls } = externalSetup(paid);
    const outcome = await agent.buy({ ...request, query: "HBAR" });
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402", "commit_spend"]);
    expect(calls[0]!.args).toMatchObject({ merchant: longZeroEvmAddress(PAYEE), amount: "500000" });
    expect(calls[1]!.args).toMatchObject({ url: "https://paid.example.run.app/price-feed?symbols=HBAR" });
    expect(outcome).toMatchObject({ status: "committed", price: 500_000n, merchant: PAYEE });
  });

  it("refuses a POST service before reserving anything: pay_x402 only fetches with GET", async () => {
    const { agent, calls } = externalSetup(paid);
    await expect(agent.buy({ ...request, service: "llm-summary" })).rejects.toThrow(/POST/);
    expect(calls).toEqual([]);
  });

  it("payUrl: reserves for the service but pays another URL, and the co-signer's refusal ends the purchase", async () => {
    const { agent, calls } = externalSetup({
      reserve_spend: reserved,
      pay_x402: new ToolCallError("pay_x402", { code: "COSIGNER_REFUSED", reason: "wrong_payee" }),
    });
    const outcome = await agent.buy({ ...request, payUrl: "https://paid.example.run.app/premium-data" });
    expect(calls[0]!.args).toMatchObject({ merchant: longZeroEvmAddress(PAYEE), amount: "500000" });
    expect(calls[1]!.args).toMatchObject({ url: "https://paid.example.run.app/premium-data" });
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402"]);
    expect(outcome).toEqual({ status: "rejected", stage: "pay", code: "COSIGNER_REFUSED" });
  });
});

describe("worker against the real auth and MCP servers", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  it("a reservation over the on-chain budget comes back as AGENT_BUDGET_EXCEEDED", async () => {
    const kya = stack.registerAgent(ROLES.Worker, 2);
    const merchant = longZeroEvmAddress("0.0.9002");
    const { chain } = stack.orchestrator;
    chain.facilities.set(facilityId.toLowerCase(), {
      seller: worker,
      buyer: worker,
      receivableAmount: 10_000_000_000n,
      dueDate: NOW + 30n * 86_400n,
      funded: 6_000_000_000n,
      committed: 0n,
      reserved: 0n,
      status: 1,
    });
    chain.available_ = 6_000_000_000n;
    chain.merchantLists.set(`${facilityId}:${kya.address}`.toLowerCase(), [merchant]);
    stack.orchestrator.spendWallets.register(spendWallet, kya.address);
    chain.budgets.set(`${facilityId}:${kya.address}`.toLowerCase(), budget({ alloc: 100_000n, maxPerTx: 500_000n, maxDaily: 500_000n }));

    const client = AgentClient.connect({ agentKey: kya.privateKey, uaid: kya.uaid, role: "worker", mandateHash: kya.record.mandateHash, mcpUrl: stack.mcpUrl });
    const agent = createWorkerAgent({ client, worker: kya.address, spendWallet, catalogUrls, fetch: catalogFetch(CATALOGS), log: () => undefined });
    expect(await agent.buy({ id: facilityId, service: "research", budgetHint: 500_000n, purchaseId: "p-1" })).toEqual({
      status: "rejected",
      stage: "reserve",
      code: "AGENT_BUDGET_EXCEEDED",
    });
    expect(chain.sent).toHaveLength(0);
  });
});
