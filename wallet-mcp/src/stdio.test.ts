/** The wallet as Claude Code launches it: a child process speaking MCP over stdio. */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { BUYER, BUYER_KEY } from "./test/fixtures.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

/** The variables `loadEnv` requires, all fake: listing tools touches no network. */
const ENV = {
  HEDERA_NETWORK: "testnet",
  HEDERA_CHAIN_ID: "296",
  HEDERA_JSON_RPC_URL: "http://127.0.0.1:9/rpc",
  HEDERA_MIRROR_NODE_URL: "http://127.0.0.1:9/mirror",
  HEDERA_OPERATOR_ID: "0.0.2",
  HEDERA_OPERATOR_KEY: "00",
  MERCHANT_ACCOUNT_ID: "0.0.3",
  MERCHANT_KEY: "00",
  USDC_TOKEN_ID: "0.0.429274",
  USDC_EVM_ADDRESS: "0x0000000000000000000000000000000000068cDa",
  X402_FACILITATOR_URL: "http://127.0.0.1:9/facilitator",
  X402_NETWORK: "hedera-testnet",
  BUYER_KEY,
  BUYER_ID: "0.0.1002",
  WALLET_ACCOUNTS: "buyer",
};

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("wallet-mcp over stdio", () => {
  it("starts as a child process and lists its tools and accounts", async () => {
    const transport = new StdioClientTransport({
      command: tsx,
      args: ["src/index.ts"],
      cwd: packageDir,
      env: { PATH: process.env.PATH ?? "", ...ENV },
      stderr: "pipe",
    });
    client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_balances", "list_accounts", "send_calls", "sign_receivable_confirmation"]);

    const listed = (await client.callTool({ name: "list_accounts", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(listed.content[0]!.text)).toEqual({ accounts: [{ account: "buyer", role: "buyer", accountId: "0.0.1002", address: BUYER.address }] });
  }, 30_000);
});
