/**
 * `pnpm -F @casheth/agents buy -- --service price-feed --receivable <id> --catalog <url>`
 * The research worker buys one service through reserve -> pay_x402 -> commit and prints the settlement and the data.
 * With `--rogue` it reserves for the service's trusted payee but pays the merchant's `/premium-data`, whose 402 names
 * another payee: the co-signer must refuse, and the run succeeds only if it does.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hashscan } from "@casheth/shared";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { mandateHashFor, spendWalletOf } from "./demoAccount.js";
import { AgentClient, type ToolCaller } from "./mcpClient.js";
import { createWorkerAgent, PurchaseError, pickOffer, type PurchaseOutcome } from "./worker.js";

export interface BuyCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface BuyCliDeps {
  fetch?: typeof fetch;
  /** Opens the MCP client; tests substitute a fake. */
  connect?: (options: { agentKey: Hex; uaid: string; role: "worker"; mandateHash: Hex; mcpUrl?: string }) => ToolCaller & { close?(): Promise<void> };
}

const USAGE = `usage: pnpm -F @casheth/agents buy -- --service <name> --receivable <id> [options]
  --service <name>      catalogue service to buy, e.g. price-feed
  --receivable <id>     receivable (facility) id whose budget pays
  --catalog <url>       merchant catalogue URL, repeatable (default http://localhost:3003/catalog;
                        an external merchant such as casheth-paid-apis is its root URL)
  --query <value>       value of the service's query parameter (default: HBAR for price-feed, "hedera x402" for research)
  --budget <usdc>       worker's budget hint in USDC (default 0.5: research maxPerTx)
  --account <PREFIX>    demo account to act as (default WORKER_RESEARCH)
  --purchase-id <id>    names the purchase: the same id replays it instead of paying twice (default: random)
  --rogue               reserve for the service's payee but pay <merchant>/premium-data, whose payee differs;
                        expects the co-signer to refuse (exit 0 only if it does)
env: MCP_RESOURCE_URL, MERCHANT_PORT`;

const DEFAULT_QUERY: Record<string, string> = { "price-feed": "HBAR", research: "hedera x402" };
const ROGUE_PATH = "/premium-data";

const show = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);

export async function main(argv: string[], env: Record<string, string | undefined>, io: BuyCliIo = { out: console.log, err: console.error }, deps: BuyCliDeps = {}): Promise<number> {
  let values;
  try {
    // `pnpm run buy -- --flag` forwards the separator on some pnpm versions; parseArgs would treat everything after it as positional.
    ({ values } = parseArgs({
      args: argv.filter((arg, i) => !(arg === "--" && i === argv.indexOf("--"))),
      options: {
        service: { type: "string" },
        receivable: { type: "string" },
        catalog: { type: "string", multiple: true },
        query: { type: "string" },
        budget: { type: "string" },
        account: { type: "string" },
        "purchase-id": { type: "string" },
        rogue: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 1;
  }
  if (values.help || !values.service || !values.receivable) {
    (values.help ? io.out : io.err)(USAGE);
    return values.help ? 0 : 1;
  }

  const account = values.account ?? "WORKER_RESEARCH";
  const agentKey = env[`${account}_KEY`] as Hex | undefined;
  const uaid = env[`${account}_UAID`];
  const evm = env[`${account}_EVM`] as Address | undefined;
  if (!agentKey || !uaid || !evm) {
    io.err(`${account}_KEY, ${account}_UAID and ${account}_EVM are required (they live in .env.accounts)`);
    return 1;
  }

  const service = values.service;
  const rogue = values.rogue === true;
  const catalogUrls = values.catalog ?? [`http://localhost:${env.MERCHANT_PORT ?? "3003"}/catalog`];
  const connect = deps.connect ?? ((options) => AgentClient.connect(options));
  const client = connect({ agentKey, uaid, role: "worker", mandateHash: mandateHashFor(account), ...(env.MCP_RESOURCE_URL ? { mcpUrl: env.MCP_RESOURCE_URL } : {}) });
  try {
    const offer = await pickOffer(catalogUrls, service, deps.fetch);
    const agent = createWorkerAgent({
      client,
      worker: evm,
      spendWallet: spendWalletOf(account),
      catalogUrls,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      log: (message, fields) => io.out(fields ? `${message} ${show(fields)}` : message),
    });
    io.out(`buying ${service} from ${new URL(offer.url).origin} (payee ${offer.payTo}) for ${formatUnits(offer.priceUnits, offer.decimals)} USDC${rogue ? `; rogue attempt: paying ${ROGUE_PATH} instead` : ""}`);
    const outcome = await agent.buy({
      id: values.receivable as Hex,
      service,
      budgetHint: parseUnits(values.budget ?? "0.5", offer.decimals),
      purchaseId: values["purchase-id"] ?? `cli-${randomUUID()}`,
      query: values.query ?? DEFAULT_QUERY[service] ?? "",
      ...(rogue ? { payUrl: new URL(ROGUE_PATH, offer.url).href } : {}),
    });
    return report(outcome, rogue, io);
  } catch (error) {
    io.err(error instanceof PurchaseError ? `${error.message} (reservation ${error.spendId}: check its status before retrying)` : error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await client.close?.();
  }
}

/** Prints the outcome; the exit code is 0 when it is what the run was meant to show. */
function report(outcome: PurchaseOutcome, rogue: boolean, io: BuyCliIo): number {
  if (outcome.status === "rejected") {
    io.out(`REFUSED at ${outcome.stage}: ${outcome.code}. Nothing was paid.`);
    if (rogue && outcome.stage === "pay" && outcome.code === "COSIGNER_REFUSED") return 0;
    io.err(`rejected at ${outcome.stage}: ${outcome.code}`);
    return 2;
  }
  io.out(`settlement tx: ${outcome.transactionId}\n${hashscan.tx(outcome.transactionId)}`);
  io.out(`data: ${show(outcome.body)}`);
  if (outcome.status === "paid_uncommitted") {
    io.err(`paid, but the commit failed (${outcome.reason}); run again with the same --purchase-id to retry the commit`);
    return 2;
  }
  if (rogue) {
    io.err("the rogue payment was NOT refused: the co-signer policy is broken");
    return 2;
  }
  io.out(`committed (reservation ${outcome.spendId})`);
  return 0;
}
