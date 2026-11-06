/** MCP server settings from the environment (`.env` + `.env.accounts`, validated by `@casheth/shared` `loadEnv`). */
import { fileURLToPath } from "node:url";
import type { Env } from "@casheth/shared";
import type { Hex } from "viem";

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
  /** Demo only: sign as seller/buyer/worker agents (`set_budgets`, `repay_receivable`, `pay_x402`). */
  agentKeysInProcess: boolean;
  /** CAIP-2 x402 network (`hedera:testnet`). */
  x402Network: string;
  usdcTokenId: string;
  /** Merchant account id -> URL origins `pay_x402` may fetch (`MERCHANT_ORIGINS`). */
  merchantOrigins: Record<string, string[]>;
  aquaFromBlock?: bigint;
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

/** `hedera-testnet` (x402 v1 style) and `hedera:testnet` (CAIP-2) both mean testnet. */
export function caip2Network(value: string): string {
  return value.includes(":") ? value : value.replace(/^hedera-/, "hedera:");
}

/**
 * `MERCHANT_ORIGINS` = comma-separated `accountId=origin` pairs (e.g. `0.0.123=http://localhost:3003`); default:
 * the demo merchant (`MERCHANT_ACCOUNT_ID`) at `http://localhost:${MERCHANT_PORT ?? 3003}`.
 */
export function merchantOrigins(env: Env): Record<string, string[]> {
  const spec = opt(env, "MERCHANT_ORIGINS") ?? `${env.MERCHANT_ACCOUNT_ID}=http://localhost:${opt(env, "MERCHANT_PORT") ?? 3003}`;
  const out: Record<string, string[]> = {};
  for (const pair of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [accountId, origin] = pair.split("=");
    if (!accountId || !origin) throw new Error(`MERCHANT_ORIGINS entry "${pair}" must be accountId=origin`);
    (out[accountId.trim()] ??= []).push(new URL(origin.trim()).origin);
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
    agentKeysInProcess: flag(env, "AGENT_KEYS_IN_PROCESS"),
    x402Network: caip2Network(env.X402_NETWORK),
    usdcTokenId: env.USDC_TOKEN_ID,
    merchantOrigins: merchantOrigins(env),
    ...(fromBlock ? { aquaFromBlock: BigInt(fromBlock) } : {}),
  };
}
