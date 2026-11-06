/** MCP server settings from the environment (`.env` + `.env.accounts`, validated by `@casheth/shared` `loadEnv`). */
import { fileURLToPath } from "node:url";
import type { Env } from "@casheth/shared";
import type { Hex } from "viem";

export const AGENT_KEY_ROLES = ["seller", "buyer", "worker"] as const;
export type AgentKeyRole = (typeof AGENT_KEY_ROLES)[number];

export type McpConfig = {
  port: number;
  /** `MCP_RESOURCE_URL`: the audience of accepted tokens; POST is served on its path. */
  resource: URL;
  /** `AUTH_ISSUER`, compared as `href` (with the trailing slash the AS puts into `iss`). */
  issuer: URL;
  dataDir: string;
  corsOrigins: string[];
  coordinatorKey: Hex;
  cosignerKey: Hex;
  kyaIssuerKey?: Hex;
  hcsTopicId?: string;
  nftTokenId?: string;
  anthropicApiKey?: string;
  /** Demo only: sign as lender agents with their `.env.accounts` keys (`fund_agents`, `close_strategy`). */
  lenderKeysInProcess: boolean;
  /**
   * Demo only: the agent roles the server signs for with their `.env.accounts` keys (`set_budgets` as seller,
   * `repay_receivable` as buyer, the worker half of `pay_x402`). `AGENT_KEYS_IN_PROCESS`, see `agentKeyRoles`.
   */
  agentKeyRoles: AgentKeyRole[];
  /** CAIP-2 x402 network (`hedera:testnet`). */
  x402Network: string;
  usdcTokenId: string;
  /** Merchant account id -> URL origins `pay_x402` may fetch (`MERCHANT_ORIGINS`). */
  merchantOrigins: Record<string, string[]>;
  aquaFromBlock?: bigint;
  /** `HFS_ENABLED=true`: also copy invoice documents to the Hedera File Service. */
  hfsEnabled: boolean;
  /** `CASHETH_LLM_PROVIDER`: `ollama` forces the local model on, any other value off, unset = use it if Ollama answers. */
  llmProvider?: string;
  /** `OLLAMA_BASE_URL`, default `http://localhost:11434`. */
  ollamaBaseUrl: string;
  /** `CASHETH_LLM_MODEL`, default `qwen2.5:7b`. */
  llmModel: string;
};

const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

function opt(env: Env, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function req(env: Env, key: string): string {
  const v = opt(env, key);
  if (!v) throw new Error(`${key} is required for the MCP server`);
  return v;
}

/** viem wants `0x`-prefixed hex keys; `.env.accounts` may hold them either way. */
export function hexKey(value: string): Hex {
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function flag(env: Env, key: string): boolean {
  return opt(env, key)?.toLowerCase() === "true";
}

/**
 * `AGENT_KEYS_IN_PROCESS`: `true` holds the seller, buyer and worker keys, unset or `false` none, and a comma-separated
 * role list only those (`seller,worker`: the buyer signs and repays from its own wallet while the server still signs
 * the worker half of the 2-of-2 x402 payment).
 */
export function agentKeyRoles(env: Env): AgentKeyRole[] {
  const value = opt(env, "AGENT_KEYS_IN_PROCESS")?.toLowerCase();
  if (!value || value === "false") return [];
  if (value === "true") return [...AGENT_KEY_ROLES];
  const roles = value.split(",").map((r) => r.trim()).filter(Boolean);
  const unknown = roles.filter((r) => !(AGENT_KEY_ROLES as readonly string[]).includes(r));
  if (unknown.length) throw new Error(`AGENT_KEYS_IN_PROCESS: unknown role ${unknown.join(", ")} (use true, false or a list of ${AGENT_KEY_ROLES.join(", ")})`);
  return AGENT_KEY_ROLES.filter((r) => roles.includes(r));
}

/** `hedera-testnet` (x402 v1 style) and `hedera:testnet` (CAIP-2) both mean testnet. */
export function caip2Network(value: string): string {
  return value.includes(":") ? value : value.replace(/^hedera-/, "hedera:");
}

/**
 * The origins `pay_x402` may fetch, per merchant payee account. The demo merchant (`MERCHANT_ACCOUNT_ID`) at
 * `http://localhost:${MERCHANT_PORT ?? 3003}` is always admitted; `MERCHANT_ORIGINS` adds external merchants as
 * comma-separated `accountId=origin` pairs (e.g. `0.0.11333304=https://paid-apis.example`), the account being the
 * `payTo` the merchant's 402 names. A payee still has to be on the worker's on-chain budget allowlist to be paid.
 */
export function merchantOrigins(env: Env): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const admit = (accountId: string, origin: string) => {
    const known = (out[accountId] ??= []);
    if (!known.includes(origin)) known.push(origin);
  };
  admit(env.MERCHANT_ACCOUNT_ID, `http://localhost:${opt(env, "MERCHANT_PORT") ?? 3003}`);
  for (const pair of (opt(env, "MERCHANT_ORIGINS") ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [accountId, origin] = pair.split("=").map((part) => part.trim());
    if (!accountId || !origin) throw new Error(`MERCHANT_ORIGINS entry "${pair}" must be accountId=origin`);
    if (!/^\d+\.\d+\.\d+$/.test(accountId)) throw new Error(`MERCHANT_ORIGINS entry "${pair}": "${accountId}" is not a Hedera account id (0.0.x)`);
    admit(accountId, new URL(origin).origin);
  }
  return out;
}

export function loadConfig(env: Env, fallbacks: { hcsTopicId?: string; nftTokenId?: string } = {}): McpConfig {
  const port = Number(opt(env, "MCP_PORT") ?? 4030);
  const fromBlock = opt(env, "AQUA_FROM_BLOCK");
  const kyaIssuer = opt(env, "KYA_ISSUER_KEY");
  const hcsTopicId = opt(env, "HCS_AUDIT_TOPIC_ID") ?? fallbacks.hcsTopicId;
  const nftTokenId = opt(env, "RECEIVABLE_NFT_TOKEN_ID") ?? fallbacks.nftTokenId;
  const anthropicApiKey = opt(env, "ANTHROPIC_API_KEY");
  const llmProvider = opt(env, "CASHETH_LLM_PROVIDER");
  return {
    port,
    resource: new URL(opt(env, "MCP_RESOURCE_URL") ?? `http://localhost:${port}/mcp`),
    issuer: new URL(opt(env, "AUTH_ISSUER") ?? "http://localhost:4020"),
    dataDir: opt(env, "DATA_DIR") ?? DEFAULT_DATA_DIR,
    corsOrigins: (opt(env, "CORS_ORIGINS") ?? "http://localhost:3000").split(",").map((s) => s.trim()).filter(Boolean),
    coordinatorKey: hexKey(req(env, "COORDINATOR_KEY")),
    cosignerKey: hexKey(req(env, "COSIGNER_KEY")),
    ...(kyaIssuer ? { kyaIssuerKey: hexKey(kyaIssuer) } : {}),
    ...(hcsTopicId ? { hcsTopicId } : {}),
    ...(nftTokenId ? { nftTokenId } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    lenderKeysInProcess: flag(env, "LENDER_KEYS_IN_PROCESS"),
    agentKeyRoles: agentKeyRoles(env),
    x402Network: caip2Network(env.X402_NETWORK),
    usdcTokenId: env.USDC_TOKEN_ID,
    merchantOrigins: merchantOrigins(env),
    ...(fromBlock ? { aquaFromBlock: BigInt(fromBlock) } : {}),
    hfsEnabled: flag(env, "HFS_ENABLED"),
    ...(llmProvider ? { llmProvider } : {}),
    ollamaBaseUrl: opt(env, "OLLAMA_BASE_URL") ?? "http://localhost:11434",
    llmModel: opt(env, "CASHETH_LLM_MODEL") ?? "qwen2.5:7b",
  };
}
