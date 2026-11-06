import { longZeroEvmAddress } from "@casheth/hedera";
import { hashscan } from "@casheth/shared";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { main, type BuyCliDeps } from "./buyCli.js";
import { ToolCallError, type ToolCaller } from "./mcpClient.js";

const PAID_APIS = "https://paid.example.run.app/";
const PAYEE = "0.0.11333304";
const RECEIVABLE = keccak256(toHex("receivable-1"));
const SPEND_ID = keccak256(toHex("spend-1"));
const TX_ID = "0.0.5005@1800000000.000000001";
const ENV = { WORKER_RESEARCH_KEY: `0x${"ab".repeat(32)}`, WORKER_RESEARCH_UAID: "uaid:aid:worker", WORKER_RESEARCH_EVM: "0x00000000000000000000000000000000000000d1" };
const PRICE_FEED_DATA = { service: "price-feed", quote: "USD", prices: [{ symbol: "HBAR", price: 0.27 }] };

const fetchPaidApis: typeof fetch = async (input) =>
  String(input) === PAID_APIS
    ? Response.json({
        network: "hedera:testnet",
        asset: { id: "0.0.429274", symbol: "USDC", decimals: 6 },
        services: [
          { method: "GET", path: "/price-feed", price: "$0.50", payTo: PAYEE, example: "/price-feed?symbols=HBAR,ETH,BTC" },
          { method: "GET", path: "/premium-data", price: "$5.00", payTo: "0.0.6666", example: "/premium-data" },
        ],
      })
    : new Response("not found", { status: 404 });

function run(argv: string[], responses: Record<string, unknown | Error>, env: Record<string, string | undefined> = ENV) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: ToolCaller & { closed?: boolean; close(): Promise<void> } = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      const response = responses[tool];
      if (response instanceof Error) throw response;
      return response as never;
    },
    close: async () => {
      client.closed = true;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const deps: BuyCliDeps = { fetch: fetchPaidApis, connect: () => client };
  const done = main(argv, env, { out: (line) => void out.push(line), err: (line) => void err.push(line) }, deps);
  return { done, calls, out, err, client };
}

const BUY = ["--service", "price-feed", "--receivable", RECEIVABLE, "--catalog", PAID_APIS, "--purchase-id", "demo-1"];
const settled = {
  reserve_spend: { id: RECEIVABLE, spendId: SPEND_ID, amount: "500000" },
  pay_x402: { spendId: SPEND_ID, transactionId: TX_ID, hashscan: `https://hashscan.io/testnet/transaction/${TX_ID}`, status: 200, body: PRICE_FEED_DATA },
  commit_spend: { spendId: SPEND_ID },
};

describe("buy cli", () => {
  it("buys /price-feed?symbols=HBAR for 0.50 USDC and prints the settlement transaction and the data", async () => {
    const { done, calls, out, client } = run(BUY, settled);
    expect(await done).toBe(0);
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402", "commit_spend"]);
    expect(calls[0]!.args).toMatchObject({ id: RECEIVABLE, merchant: longZeroEvmAddress(PAYEE), amount: "500000", worker: ENV.WORKER_RESEARCH_EVM });
    expect(calls[1]!.args).toMatchObject({ url: "https://paid.example.run.app/price-feed?symbols=HBAR" });
    const text = out.join("\n");
    expect(text).toContain(TX_ID);
    expect(text).toContain(hashscan.tx(TX_ID));
    expect(text).toContain('"symbol": "HBAR"');
    expect(client.closed).toBe(true);
  });

  it("--query sets the value of the service's query parameter", async () => {
    const { done, calls } = run([...BUY, "--query", "HBAR,ETH"], settled);
    expect(await done).toBe(0);
    expect(calls[1]!.args).toMatchObject({ url: "https://paid.example.run.app/price-feed?symbols=HBAR%2CETH" });
  });

  it("--rogue reserves for the trusted payee, pays /premium-data, and prints the co-signer's refusal", async () => {
    const refusal = new ToolCallError("pay_x402", { code: "COSIGNER_REFUSED", reason: "wrong_payee", message: "co-signer refused: wrong_payee" });
    const { done, calls, out } = run([...BUY, "--rogue"], { ...settled, pay_x402: refusal });
    expect(await done).toBe(0);
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend", "pay_x402"]);
    expect(calls[0]!.args).toMatchObject({ merchant: longZeroEvmAddress(PAYEE), amount: "500000" });
    expect(calls[1]!.args).toMatchObject({ url: "https://paid.example.run.app/premium-data" });
    const text = out.join("\n");
    expect(text).toMatch(/REFUSED.*COSIGNER_REFUSED/);
    expect(text).toContain("wrong_payee");
    expect(text).toMatch(/nothing was paid/i);
  });

  it("--rogue fails loudly if the rogue payment went through", async () => {
    const { done, err } = run([...BUY, "--rogue"], settled);
    expect(await done).toBe(2);
    expect(err.join("\n")).toMatch(/rogue payment was NOT refused/);
  });

  it("a rejection without --rogue is a failure and prints the code", async () => {
    const rejected = new ToolCallError("reserve_spend", { code: "MERCHANT_NOT_ALLOWED", stage: "engine" });
    const { done, calls, err } = run(BUY, { ...settled, reserve_spend: rejected });
    expect(await done).toBe(2);
    expect(calls.map((c) => c.tool)).toEqual(["reserve_spend"]);
    expect(err.join("\n")).toMatch(/rejected at reserve: MERCHANT_NOT_ALLOWED/);
  });

  it("reports an unknown service with the catalogue it looked in", async () => {
    const { done, calls, err } = run(["--service", "nope", "--receivable", RECEIVABLE, "--catalog", PAID_APIS], settled);
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
    expect(err.join("\n")).toMatch(/no offer for "nope"/);
  });

  it("prints usage without --service and --receivable, and asks for the account variables", async () => {
    expect(await run(["--service", "price-feed"], settled).done).toBe(1);
    const noEnv = run(BUY, settled, {});
    expect(await noEnv.done).toBe(1);
    expect(noEnv.err.join("\n")).toMatch(/WORKER_RESEARCH_KEY, WORKER_RESEARCH_UAID and WORKER_RESEARCH_EVM/);
  });
});
