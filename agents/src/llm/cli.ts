/**
 * `pnpm -F @casheth/agents llm -- --role worker --receivable <id> --goal "..."`
 * Runs one LLM-driven agent against the MCP server as a demo account (`<ACCOUNT>_KEY` / `_UAID` / `_EVM` in `.env.accounts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EventStore } from "@casheth/engine";
import { longZeroEvmAddress } from "@casheth/hedera";
import { keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { AgentClient } from "../mcpClient.js";
import { LlmAgent, type LlmToolClient } from "./agent.js";
import { eventStoreSink } from "./audit.js";
import { catalogTool } from "./catalogTool.js";
import { createModel, NoProviderError, selectProvider } from "./provider.js";
import { DEFAULT_ALLOW_TOOLS, LLM_ROLES, type LlmRole } from "./prompts.js";
import { callReply, scriptedModel, textReply } from "./scripted.js";
import type { ChatModel } from "./types.js";
import type { LocalTool } from "./tools.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  fetch?: typeof fetch;
  /** Opens the MCP client; tests substitute a fake. */
  connect?: (options: ConnectOptions) => LlmToolClient & { close?(): Promise<void> };
  /** Where the audit trail goes (default `agents/data/llm-audit.jsonl`). */
  auditFile?: string;
}

interface ConnectOptions {
  agentKey: Hex;
  uaid: string;
  role: LlmRole;
  mandateHash: Hex;
  mcpUrl?: string;
}

const USAGE = `usage: pnpm -F @casheth/agents llm -- --role worker|seller|lender --goal "<what to achieve>" [options]
  --receivable <id>     receivable (facility) id; pinned on every tool that takes an id
  --account <PREFIX>    demo account to act as (default: WORKER_RESEARCH / SELLER / LENDER_A by role)
  --allow a,b           side-effecting tools the model may use (default: the role's tools, see docs/LLM_AGENTS.md)
  --max-spend <usdc>    spend cap for the run in USDC, e.g. 0.5 (default 1; applies when reserve_spend is allowed)
  --max-steps <n>       model turns before stopping (default 12)
  --catalog <url>       merchant /catalog URL, repeatable (default http://localhost:3003/catalog)
  --dry-run             fake model, one read-only call: checks the wiring without a model server
env: CASHETH_LLM_PROVIDER (ollama|anthropic), CASHETH_LLM_MODEL, OLLAMA_BASE_URL, ANTHROPIC_API_KEY, MCP_RESOURCE_URL`;

const DEFAULT_ACCOUNT: Record<LlmRole, string> = { worker: "WORKER_RESEARCH", seller: "SELLER", lender: "LENDER_A" };
/** A read-only tool each role can call on its own, used by `--dry-run`. */
const DRY_RUN_TOOL: Record<LlmRole, string> = { worker: "list_catalog", seller: "list_agents", lender: "list_agents" };

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);

/** `WORKER_RESEARCH` -> the mandate hash `scripts/c2-register-demo.ts` registered for `workerResearch`. */
function mandateHashFor(account: string): Hex {
  const label = account.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return keccak256(toHex(`mandate-v1-${label}`));
}

/** Long-zero EVM address of the worker's 2-of-2 spend wallet, from `deployments/testnet/spend-wallets.json`. */
function spendWalletOf(account: string): Address {
  const { wallets } = JSON.parse(readFileSync(repoFile("deployments/testnet/spend-wallets.json"), "utf8")) as {
    wallets: Record<string, { evmAddress: Address; worker: { name: string } }>;
  };
  const wallet = Object.values(wallets).find((w) => w.worker.name === account);
  if (!wallet) throw new Error(`no spend wallet registered for ${account} in deployments/testnet/spend-wallets.json`);
  return wallet.evmAddress;
}

function dryRunModel(role: LlmRole): ChatModel {
  return scriptedModel(
    (messages) =>
      messages.some((m) => m.role === "tool")
        ? textReply("Dry run complete: the tool round trip works. No model was consulted and nothing was changed.")
        : callReply("Dry run: one read-only call to check the wiring.", { name: DRY_RUN_TOOL[role] }),
    "dry-run",
  );
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo = { out: console.log, err: console.error }, deps: CliDeps = {}): Promise<number> {
  let values;
  try {
    // `pnpm run llm -- --flag` forwards the separator on some pnpm versions; parseArgs would treat everything after it as positional.
    ({ values } = parseArgs({
      args: argv.filter((arg, i) => !(arg === "--" && i === argv.indexOf("--"))),
      options: {
        role: { type: "string" },
        goal: { type: "string" },
        receivable: { type: "string" },
        account: { type: "string" },
        allow: { type: "string" },
        "max-spend": { type: "string" },
        "max-steps": { type: "string" },
        catalog: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 1;
  }
  const role = values.role as LlmRole | undefined;
  if (values.help || !role || !LLM_ROLES.includes(role) || !values.goal) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? 0 : 1;
  }

  let model: ChatModel;
  if (values["dry-run"]) {
    model = dryRunModel(role);
  } else {
    try {
      model = createModel(await selectProvider(env, deps.fetch), deps.fetch);
    } catch (error) {
      if (!(error instanceof NoProviderError)) throw error;
      io.err(error.message);
      return 1;
    }
  }
  io.out(`LLM provider: ${model.provider}, model: ${model.model}`);

  const account = values.account ?? DEFAULT_ACCOUNT[role];
  const agentKey = env[`${account}_KEY`] as Hex | undefined;
  const uaid = env[`${account}_UAID`];
  const evm = env[`${account}_EVM`] as Address | undefined;
  if (!agentKey || !uaid || !evm) {
    io.err(`${account}_KEY, ${account}_UAID and ${account}_EVM are required (they live in .env.accounts)`);
    return 1;
  }

  const allowTools = values.allow ? values.allow.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOW_TOOLS[role];
  const maxSpend = parseUnits(values["max-spend"] ?? "1", 6);
  const pinned: Record<string, unknown> = {
    ...(values.receivable ? { id: values.receivable } : {}),
    ...(role === "worker" ? { worker: evm, spendWallet: spendWalletOf(account) } : {}),
  };
  const catalogUrls = values.catalog ?? [`http://localhost:${env.MERCHANT_PORT ?? "3003"}/catalog`];
  const localTools: LocalTool[] = role === "worker" ? [catalogTool(catalogUrls, deps.fetch)] : [];

  const connect = deps.connect ?? ((options: ConnectOptions) => AgentClient.connect(options));
  const client = connect({ agentKey, uaid, role, mandateHash: mandateHashFor(account), ...(env.MCP_RESOURCE_URL ? { mcpUrl: env.MCP_RESOURCE_URL } : {}) });
  try {
    const auditFile = deps.auditFile ?? fileURLToPath(new URL("../../data/llm-audit.jsonl", import.meta.url));
    const agent = new LlmAgent({
      client,
      model,
      role,
      allowTools,
      maxSpend,
      maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
      pinned,
      localTools,
      audit: eventStoreSink(new EventStore(auditFile), {
        role,
        model: `${model.provider}:${model.model}`,
        agentUaid: uaid,
        ...(values.receivable ? { id: values.receivable } : {}),
      }),
      log: (message, fields) => io.out(fields ? `${message} ${JSON.stringify(fields, (_, v) => (typeof v === "bigint" ? v.toString() : v))}` : message),
    });
    const result = await agent.run(values.goal);
    io.out(`\n${result.answer || "(no final answer)"}\n`);
    io.out(`run ${result.runId}: ${result.status} in ${result.steps} step(s), ${result.toolCalls.length} tool call(s), reserved ${result.spent} base units; audit trail: ${auditFile}`);
    return result.status === "completed" ? 0 : 2;
  } finally {
    await client.close?.();
  }
}
