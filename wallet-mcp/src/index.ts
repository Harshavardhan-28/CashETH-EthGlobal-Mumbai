/**
 * `pnpm -s -F @casheth/wallet-mcp start`: the local stdio MCP server Claude Code launches as `casheth-wallet`
 * (`.mcp.json`). It reads the keys from the repo's `.env.accounts`; stdout carries the MCP protocol, so the one
 * status line goes to stderr and names account labels only.
 */
import { loadEnv } from "@casheth/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { liveWalletDeps } from "./live.js";
import { createWalletServer } from "./server.js";

const deps = liveWalletDeps(loadEnv());
await createWalletServer(deps).connect(new StdioServerTransport());
const held = deps.ring.list().map((a) => a.account);
console.error(`casheth-wallet ready (accounts: ${held.join(", ") || "none"}, approve cap ${deps.approveCap} units)`);
