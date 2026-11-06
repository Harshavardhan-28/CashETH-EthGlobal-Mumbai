/** Run settings from the environment, overridden by command-line flags. Nothing secret lives here. */
import { parseArgs } from "node:util";

export const LIVE_PAID_API = "https://casheth-paid-apis-177290233934.asia-southeast1.run.app";

export interface SellerAgentConfig {
  ollamaBaseUrl: string;
  model: string;
  /**
   * Ollama context window in tokens. Ollama's default (4096) silently drops the start of a long prompt, the system
   * prompt first; the full run (tool schemas, quotes, a dozen tool results) needs more.
   */
  numCtx: number;
  /** The paid resource the agent wants. */
  paidApiUrl: string;
  maxSteps: number;
  /** USDC units the run may reserve in total. */
  spendCap: bigint;
  /** Face value of the fresh invoice, decimal USDC. */
  invoiceUsdc: string;
  /** Start the auth, MCP and merchant servers (agents/src/demo/servers.ts) instead of using running ones. */
  startServers: boolean;
}

type EnvLike = Record<string, string | undefined>;

const pick = (env: EnvLike, key: string, fallback: string): string => {
  const value = env[key]?.trim();
  return value ? value : fallback;
};

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`max steps must be a positive integer, got "${value}"`);
  return n;
}

export function configFrom(env: EnvLike, argv: string[]): SellerAgentConfig {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      model: { type: "string" },
      "paid-url": { type: "string" },
      "max-steps": { type: "string" },
      "start-servers": { type: "boolean" },
    },
  });
  return {
    ollamaBaseUrl: pick(env, "OLLAMA_BASE_URL", "http://localhost:11434"),
    model: values.model ?? pick(env, "CASHETH_LLM_MODEL", "qwen3:8b"),
    numCtx: Number(pick(env, "SELLER_AGENT_NUM_CTX", "16384")),
    paidApiUrl: values["paid-url"] ?? pick(env, "SELLER_AGENT_PAID_URL", `${LIVE_PAID_API}/price-feed?symbols=HBAR`),
    maxSteps: positiveInt(values["max-steps"] ?? pick(env, "SELLER_AGENT_MAX_STEPS", "30")),
    spendCap: BigInt(pick(env, "SELLER_AGENT_SPEND_CAP", "1000000")),
    invoiceUsdc: pick(env, "SELLER_AGENT_INVOICE_USDC", "2.00"),
    startServers: values["start-servers"] ?? false,
  };
}
