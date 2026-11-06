/**
 * `pnpm -F @casheth/seller-agent start [--start-servers] [--model qwen3:8b] [--max-steps 30] [--paid-url <url>]`
 *
 * One demonstration on Hedera testnet: the seller agent (Ollama via LangGraph) hits the paid API's 402, raises
 * credit through the CashETH MCP tools, buys the data through its research worker and has the buyer repay.
 * Keys are read from `.env.accounts` into the MCP clients and the buyer's wallet only; the model never sees them.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient, createBuyerAgent, loadIdentity, mcpResourceUrl, spendWalletOf, startServers, walletCallSender, type AgentIdentity, type AgentWallet } from "@casheth/agents";
import { evmClients } from "@casheth/hedera";
import { loadEnv } from "@casheth/shared";
import { privateKeyToAccount } from "viem/accounts";
import { configFrom } from "./config.js";
import { formatUpdate, linksTable } from "./console.js";
import { freshInvoice } from "./invoice.js";
import { assertModelAvailable, ollamaChatModel } from "./model.js";
import { runSellerAgent } from "./run.js";
import { fileTranscript } from "./transcript.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** Quotes and funding scan every lender strategy over a sometimes slow relay (as in the scripted demo). */
const CALL_TIMEOUT_MS = 600_000;

async function main(): Promise<number> {
  const env = loadEnv();
  const config = configFrom(process.env, process.argv.slice(2));
  await assertModelAvailable(config.ollamaBaseUrl, config.model);
  const servers = config.startServers ? await startServers(env, root) : undefined;
  const mcpUrl = mcpResourceUrl(env);
  const connect = (id: AgentIdentity) =>
    AgentClient.connect({ agentKey: id.key, uaid: id.uaid, role: id.role, mandateHash: id.mandateHash, mcpUrl, callTimeoutMs: CALL_TIMEOUT_MS });

  const [seller, worker, buyer] = await Promise.all((["SELLER", "WORKER_RESEARCH", "BUYER"] as const).map((prefix) => loadIdentity(env, prefix)));
  const clients = { seller: connect(seller), worker: connect(worker), buyer: connect(buyer) };
  try {
    const invoice = await freshInvoice({ buyer: buyer.address, amountUsdc: config.invoiceUsdc });
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const transcript = fileTranscript(join(root, "seller-agent", "runs"), runId);
    console.log(`seller agent run ${runId}: ${config.model} at ${config.ollamaBaseUrl}, MCP ${mcpUrl}, invoice ${invoice.buyerRef}, wants ${config.paidApiUrl}`);

    const result = await runSellerAgent({
      model: ollamaChatModel(config.ollamaBaseUrl, config.model),
      seller: clients.seller,
      worker: clients.worker,
      buyer: createBuyerAgent({
        client: clients.buyer,
        account: privateKeyToAccount(buyer.key),
        send: walletCallSender(evmClients(env, buyer.key).wallet as AgentWallet),
      }),
      account: {
        seller: { address: seller.address, accountId: seller.accountId },
        worker: { address: worker.address, accountId: worker.accountId, spendWallet: spendWalletOf("WORKER_RESEARCH") },
      },
      invoice,
      paidApiUrl: config.paidApiUrl,
      runId,
      maxSteps: config.maxSteps,
      spendCap: config.spendCap,
      transcript,
      onNode: (node, update) => formatUpdate(node, update).forEach((line) => console.log(line)),
    });

    console.log(`\nstatus: ${result.status}${result.error ? ` (${result.error})` : ""}`);
    console.log(`receivable ${result.facts.receivableId ?? "-"}, settlement ${result.facts.settlement?.transactionId ?? "-"}, repayment ${result.facts.repayTx ?? "-"}`);
    if (result.answer) console.log(`\nagent summary:\n${result.answer}`);
    console.log(`\n${linksTable(result.audit).join("\n")}`);
    console.log(`\ntranscript: ${transcript.path}`);
    return result.status === "completed" ? 0 : 1;
  } finally {
    await Promise.allSettled(Object.values(clients).map((client) => client.close()));
    servers?.stop();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
process.exit();
