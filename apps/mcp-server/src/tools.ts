/**
 * The CashETH MCP tool set (BUILD.md section 5.3 plus plan Addendum A). Every tool checks its scope and role from
 * the access token; every mutating tool takes an `idempotencyKey` and replays the first successful result for the
 * same (tool, agent, key). Results and errors are JSON text content; errors set `isError` and carry a `code`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { keccak256, toHex } from "viem";
import { z } from "zod";
import { callerFrom, InsufficientScopeError, requireRoleAndScope, type RoleName } from "./auth.js";
import { registerAgent } from "./orchestrator/agents.js";
import { jsonSafe } from "./orchestrator/audit.js";
import { addr, ROLE_NAMES } from "./orchestrator/common.js";
import { ToolError } from "./orchestrator/errors.js";
import { explainDecision } from "./orchestrator/explain.js";
import { getQuotes, openFacility, setBudgets } from "./orchestrator/facility.js";
import { getInvoiceDocument, MAX_DOCUMENT_BASE64_CHARS, uploadInvoiceDocument } from "./orchestrator/invoices.js";
import { closeStrategy, fundAgents } from "./orchestrator/lender.js";
import { confirmReceivable, decisionFor, receivableDetails, uploadReceivable } from "./orchestrator/receivables.js";
import { repayReceivable } from "./orchestrator/repay.js";
import { buyWithCredit, requestBuyerConfirmation, settleReceivable } from "./orchestrator/counterparty.js";
import { commitSpend, payX402, releaseSpend, reserveSpend } from "./orchestrator/spend.js";
import type { Caller, Orchestrator } from "./orchestrator/types.js";

const idempotencyKey = z.string().min(8).max(128).describe("Client-chosen key; a repeat with the same key replays the first result");
const hex32 = z.string().describe("0x-prefixed 32-byte hex");
const address = z.string().describe("EVM address");
const amount = z.string().regex(/^\d+$/).describe("USDC base units (6 decimals) as a decimal string");

type Shape = z.ZodRawShape;

export type ToolSpec<S extends Shape> = {
  name: string;
  description: string;
  roles: readonly RoleName[] | "any";
  scope: string;
  mutating: boolean;
  input: S;
  /** Mutating tools also receive the validated `idempotencyKey`. */
  run: (o: Orchestrator, caller: Caller, args: z.infer<z.ZodObject<S>> & { idempotencyKey: string }) => Promise<unknown>;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

const inflightByLedger = new WeakMap<object, Map<string, Promise<unknown>>>();

type Stored = { argsHash: string; result: unknown };

/** Runs `run` once per (tool, agent, idempotencyKey); a repeat returns the stored first result. */
async function idempotent(
  o: Orchestrator,
  caller: Caller,
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<{ result: unknown; replayed: boolean }> {
  const { idempotencyKey: key, ...rest } = args;
  const ledgerKey = `${tool}:${caller.agent.toLowerCase()}:${String(key)}`;
  const argsHash = keccak256(toHex(JSON.stringify(stable(rest))));
  const prior = o.idempotency.get<Stored>(ledgerKey);
  if (prior) {
    if (prior.argsHash !== argsHash) {
      throw new ToolError("IDEMPOTENCY_KEY_REUSED", "this idempotencyKey was already used with different arguments");
    }
    return { result: prior.result, replayed: true };
  }
  let inflight = inflightByLedger.get(o.idempotency);
  if (!inflight) inflightByLedger.set(o.idempotency, (inflight = new Map()));
  const running = inflight.get(ledgerKey);
  if (running) return { result: await running, replayed: true };
  const promise = run()
    .then((r) => {
      const result = jsonSafe(r);
      o.idempotency.put<Stored>(ledgerKey, { argsHash, result });
      return result;
    })
    .finally(() => inflight.delete(ledgerKey));
  inflight.set(ledgerKey, promise);
  return { result: await promise, replayed: false };
}

function text(value: unknown): CallToolResult["content"] {
  return [{ type: "text", text: JSON.stringify(jsonSafe(value)) }];
}

function errorBody(err: unknown): Record<string, unknown> {
  if (err instanceof InsufficientScopeError || err instanceof ToolError) return err.toJSON();
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

function register<S extends Shape>(server: McpServer, o: Orchestrator, spec: ToolSpec<S>): void {
  const input = spec.mutating ? { ...spec.input, idempotencyKey } : spec.input;
  const roles = spec.roles === "any" ? "any role" : spec.roles.join(" or ");
  server.registerTool(
    spec.name,
    { description: `${spec.description} [role: ${roles}; scope: ${spec.scope}]`, inputSchema: input },
    // The SDK has already validated `args` against `input`.
    (async (args: Record<string, unknown>, extra: { authInfo?: Parameters<typeof callerFrom>[0] }): Promise<CallToolResult> => {
      const started = Date.now();
      let caller: Caller | undefined;
      try {
        caller = callerFrom(extra.authInfo);
        requireRoleAndScope(caller, spec.roles, spec.scope);
        const c = caller;
        const run = () => spec.run(o, c, args as z.infer<z.ZodObject<S>> & { idempotencyKey: string });
        const { result, replayed } = spec.mutating ? await idempotent(o, c, spec.name, args, run) : { result: await run(), replayed: false };
        o.log("tool", { tool: spec.name, agent: c.agent, sub: c.sub, jti: c.jti, ok: true, replayed, ms: Date.now() - started });
        return { content: text(result), ...(replayed ? { _meta: { replayed: true } } : {}) };
      } catch (err) {
        const body = errorBody(err);
        o.log("tool", { tool: spec.name, agent: caller?.agent, sub: caller?.sub, jti: caller?.jti, ok: false, code: body.code, ms: Date.now() - started });
        return { isError: true, content: text(body) };
      }
    }) as never,
  );
}


/** Registers all 20 tools on `server`. */
export function registerTools(server: McpServer, o: Orchestrator): void {
  const add = <S extends Shape>(spec: ToolSpec<S>) => register(server, o, spec);

  add({
    name: "register_agent",
    description: "Owner/admin: register an agent in KYARegistry (KYA issuer key) and publish its HCS-14 profile.",
    roles: "any",
    scope: "agent:admin",
    mutating: true,
    input: {
      account: address,
      accountId: z.string().describe("Hedera account id 0.0.x"),
      name: z.string().min(1).max(64),
      role: z.enum(["seller", "buyer", "worker", "lender"]),
      level: z.number().int().min(0).max(3),
      ownerGroup: z.string().min(1).describe("Owner-group label (hashed) or a 32-byte hash"),
      mandateHash: hex32.optional(),
      expiresAt: z.number().int().nonnegative().optional().describe("Unix seconds; 0 = never"),
    },
    run: (o, c, a) => registerAgent(o, c, a),
  });

  add({
    name: "upload_invoice_document",
    description:
      "Seller: store an invoice document (PDF or plain text, at most 2 MB). Its keccak256 can become the receivable's detailsCommitment (pass it to upload_receivable as documentKeccak). Anchors the hashes on HCS and returns the fields read from the document; give `expected` to also get the field verification.",
    roles: ["seller"],
    scope: "receivable:write",
    mutating: true,
    input: {
      receivableRef: z.string().min(1).max(66).describe("The buyer PO reference or receivable id this document belongs to (recorded on HCS)"),
      filename: z.string().min(1).max(128),
      mime: z.enum(["application/pdf", "text/plain"]),
      content: z.string().min(1).max(MAX_DOCUMENT_BASE64_CHARS).describe("Base64 of the file, at most 2 MB decoded"),
      expected: z
        .object({
          amount,
          currency: z.string().optional().describe("Default USDC"),
          dueDate: z.number().int().positive(),
          buyerRef: z.string().min(1),
          sellerName: z.string().optional(),
          buyerName: z.string().optional(),
        })
        .optional()
        .describe("Terms to check the document's printed fields against"),
    },
    run: (o, c, a) => uploadInvoiceDocument(o, c, a),
  });

  add({
    name: "get_invoice_document",
    description:
      "Any role: metadata, extracted fields and integrity checks of a stored invoice document (the stored bytes still hash to keccak; the registry commitment of the receivable uploaded with it). The file itself is GET /invoices/:keccak.",
    roles: "any",
    scope: "receivable:read",
    mutating: false,
    input: { keccak: hex32.describe("keccak256 of the document") },
    run: (o, c, a) => getInvoiceDocument(o, c, a),
  });

  add({
    name: "upload_receivable",
    description:
      "Seller: upload receivable terms. Returns a pendingId and the EIP-712 ReceivableConfirmation typed data the buyer must sign (uint fields as decimal strings). Give documentKeccak (from upload_invoice_document) to commit to the invoice file: its printed amount, due date and buyer reference must match these terms (INVOICE_MISMATCH otherwise).",
    roles: ["seller"],
    scope: "receivable:write",
    mutating: true,
    input: {
      seller: address.optional().describe("Defaults to the caller; must be the caller"),
      buyer: address,
      amount,
      dueDate: z.number().int().positive().describe("Unix seconds, 1 to 120 days out"),
      buyerRef: z.string().min(1).describe("Buyer PO/AP reference: a 32-byte hex, or text that is hashed"),
      documentKeccak: hex32.optional().describe("keccak256 of an invoice document stored with upload_invoice_document; becomes the detailsCommitment"),
      detailsCommitment: hex32.optional().describe("A 32-byte commitment of your own; required when there is no documentKeccak"),
    },
    run: (o, c, a) => uploadReceivable(o, c, a),
  });

  add({
    name: "confirm_receivable",
    description:
      "Buyer: submit the EIP-712 signature. Verifies, dedupes, scores and checks KYA, then registers on-chain, mints the receivable NFT and records it on HCS.",
    roles: ["buyer"],
    scope: "receivable:confirm",
    mutating: true,
    input: { pendingId: hex32, signature: z.string().describe("65-byte r||s||v hex signature") },
    run: (o, c, a) => confirmReceivable(o, c, a),
  });

  add({
    name: "get_receivable_status",
    description: "Any role: on-chain state, facility funding, debt, lender positions, evidence links and the credit decision of a receivable.",
    roles: "any",
    scope: "receivable:read",
    mutating: false,
    input: { id: hex32 },
    run: async (o, _c, a) => {
      const details = await receivableDetails(o, a.id);
      const decision = details.state === "Pending" ? undefined : await decisionFor(o, details.id).then((d) => d.decision).catch(() => undefined);
      return { ...details, ...(decision ? { decision } : {}) };
    },
  });

  add({
    name: "get_quotes",
    description: "Seller: open lender strategies and the cheapest-first solver preview for a Confirmed receivable (no transaction).",
    roles: ["seller"],
    scope: "credit:read",
    mutating: false,
    input: { id: hex32 },
    run: (o, c, a) => getQuotes(o, c, a),
  });

  add({
    name: "open_facility",
    description: "Seller: fund the receivable from the cheapest eligible lender strategies via CreditFacility.openAndFund (coordinator).",
    roles: ["seller"],
    scope: "facility:open",
    mutating: true,
    input: { id: hex32 },
    run: (o, c, a) => openFacility(o, c, a),
  });

  add({
    name: "set_budgets",
    description:
      "Seller: per-worker budgets and limits (CreditFacility.setBudgets). Sent by the server only when it holds the seller key (demo); otherwise returns the calldata to sign.",
    roles: ["seller"],
    scope: "budget:write",
    mutating: true,
    input: {
      id: hex32,
      budgets: z
        .array(z.object({ worker: address, alloc: amount, maxPerTx: amount, maxDaily: amount, merchants: z.array(address) }))
        .min(1),
    },
    run: (o, c, a) => setBudgets(o, c, a),
  });

  add({
    name: "reserve_spend",
    description:
      "Seller or worker: engine spend check, then CreditFacility.reserve moves exactly `amount` USDC to the spend wallet. Rejections carry the error code (AGENT_BUDGET_EXCEEDED, TX_LIMIT_EXCEEDED, ...).",
    roles: ["seller", "worker"],
    scope: "spend:reserve",
    mutating: true,
    input: {
      id: hex32,
      worker: address,
      spendWallet: address.describe("Spend wallet EVM address (long-zero form of its account id)"),
      merchant: address,
      amount,
      ttlSeconds: z.number().int().min(30).max(3600).optional().describe("Default 600"),
    },
    run: (o, c, a) => reserveSpend(o, c, a),
  });

  add({
    name: "pay_x402",
    description:
      "Worker: pay an x402 URL from the reservation's 2-of-2 spend wallet; the co-signer signs only a payment matching the open reservation, and only one per reservation (a retry returns the first settlement; PAYMENT_IN_FLIGHT while one is pending). Returns the Hedera transaction id.",
    roles: ["worker"],
    scope: "spend:pay",
    mutating: true,
    input: { spendId: hex32, url: z.string().url() },
    run: (o, c, a) => payX402(o, c, a),
  });

  add({
    name: "commit_spend",
    description: "Worker: record the payment's Hedera transaction id on the reservation (CreditFacility.commit, coordinator); allowed while it is open, after its expiry too.",
    roles: ["worker"],
    scope: "spend:commit",
    mutating: true,
    input: { spendId: hex32, hederaTxId: z.string().describe("0.0.x@seconds.nanos") },
    run: (o, c, a) => commitSpend(o, c, a),
  });

  add({
    name: "release_spend",
    description:
      "Worker of the reservation or seller of its facility: return an expired, unpaid reservation's USDC to the facility (CreditFacility.release, coordinator) and free the spend wallet. A paid reservation must be committed instead; one with a co-signed payment whose settlement was never seen can be released 180 s after the co-signature.",
    roles: ["seller", "worker"],
    scope: "spend:reserve",
    mutating: true,
    input: { spendId: hex32 },
    run: (o, c, a) => releaseSpend(o, c, a),
  });

  add({
    name: "repay_receivable",
    description:
      "Buyer: approve USDC to the RepaymentRouter and repay (lenders first, seller the rest). Sent only when the server holds the buyer key (demo); otherwise returns both calldatas. A Repaid receivable is refused with ALREADY_REPAID.",
    roles: ["buyer"],
    scope: "repay:write",
    mutating: true,
    input: { id: hex32, amount },
    run: (o, c, a) => repayReceivable(o, c, a),
  });

  add({
    name: "explain_decision",
    description: "Any role: plain-language explanation of the deterministic credit decision. The AI explains, it never approves or changes it.",
    roles: "any",
    scope: "credit:read",
    mutating: false,
    input: { id: hex32 },
    run: (o, c, a) => explainDecision(o, c, a),
  });

  add({
    name: "list_agents",
    description: "Any role: stats of every known agent (score, tier, on-time %, receivables, spend by merchant).",
    roles: "any",
    scope: "stats:read",
    mutating: false,
    input: {},
    run: (o) => o.stats.listAgents(),
  });

  add({
    name: "get_agent_stats",
    description: "Any role: stats of one agent (defaults to the caller).",
    roles: "any",
    scope: "stats:read",
    mutating: false,
    input: { address: address.optional() },
    run: (o, c, a) => o.stats.agentStats(a.address ? addr(a.address, "address") : c.agent),
  });

  add({
    name: "request_buyer_confirmation",
    description:
      "Seller: ask the buyer of a pending receivable to confirm it. The buyer counterparty (run by the server with its own key, demo) signs the EIP-712 confirmation and the receivable is registered; returns what confirm_receivable returns (id, credit decision, NFT, HashScan link).",
    roles: ["seller"],
    scope: "receivable:write",
    mutating: true,
    input: { pendingId: hex32 },
    run: (o, c, a) => requestBuyerConfirmation(o, c, a),
  });

  add({
    name: "buy_with_credit",
    description:
      "Seller: buy a paid x402 resource with the facility's credit, through the seller's worker and its 2-of-2 spend wallet: reserve_spend, pay_x402 (the co-signer checks the payment against the reservation) and commit_spend in one call. `merchant` is the payee's Hedera account id (0.0.N) or EVM address and must be on the worker's budget allowlist; `url` must be on that merchant's configured origin.",
    roles: ["seller"],
    scope: "spend:reserve",
    mutating: true,
    input: { id: hex32, url: z.string().url(), merchant: z.string().min(5), amount, ttlSeconds: z.number().int().min(60).max(3600).optional() },
    run: (o, c, a) => buyWithCredit(o, c, a),
  });

  add({
    name: "settle_receivable",
    description:
      "Seller: settle a financed receivable. The buyer counterparty (server-held key, demo) pays the full invoice amount into the RepaymentRouter: lenders get principal plus fee first, the seller the rest, and the receivable becomes Repaid.",
    roles: ["seller"],
    scope: "receivable:write",
    mutating: true,
    input: { id: hex32 },
    run: (o, c, a) => settleReceivable(o, c, a),
  });

  add({
    name: "whoami",
    description: "Any role: the caller's own identity (address, role, KYA level, scopes) from its token. Instant: no chain reads, unlike get_agent_stats.",
    roles: "any",
    scope: "stats:read",
    mutating: false,
    input: {},
    run: async (_o, c) => ({ address: c.agent, role: ROLE_NAMES[c.role as keyof typeof ROLE_NAMES] ?? "unknown", level: c.level, scopes: c.scopes }),
  });

  add({
    name: "fund_agents",
    description:
      "Lender: ship a credit strategy for the risk slabs you fund (low: score 700+, 6-8% APR; medium: 600-699, 8-11%; high: 500-599, 11-14%) and optionally up to 3 sellers you back, plus an optional base-yield strategy from the same wallet. The rate is the seller's own, computed on chain from its score; lenders choose risk, not price. Ships only when the server holds the lender key (demo); otherwise returns the approve and ship calldatas.",
    roles: ["lender"],
    scope: "lend:write",
    mutating: true,
    input: {
      slabs: z.array(z.enum(["low", "medium", "high"])).min(1).describe("Risk slabs this strategy funds"),
      sellers: z.array(address).max(3).optional().describe("Only these sellers (still only within the funded slabs)"),
      maxPerBuyer: amount.optional(),
      minReserve: amount.optional(),
      maxTenorDays: z.number().int().min(1).max(65535).optional().describe("Default 60"),
      maxAdvanceBps: z.number().int().min(0).max(10000).optional().describe("Default 8000"),
      creditUsdc: amount.describe("USDC shipped to the credit strategy"),
      base: z
        .object({ usdc: amount, tUsdt: amount, feeBps: z.number().int().min(0).max(9999).optional().describe("Default 30 (0.3%)") })
        .optional(),
    },
    run: (o, c, a) => fundAgents(o, c, a),
  });

  add({
    name: "get_lender_yield",
    description: "Lender: capital, lent, idle, base and credit fees and APRs (defaults to the caller).",
    roles: ["lender"],
    scope: "stats:read",
    mutating: false,
    input: { address: address.optional() },
    run: (o, c, a) => o.stats.lenderYield(a.address ? addr(a.address, "address") : c.agent),
  });

  add({
    name: "close_strategy",
    description: "Lender: dock (close) one of the caller's open Aqua strategies. Sent only when the server holds the lender key; otherwise returns the calldata.",
    roles: ["lender"],
    scope: "lend:write",
    mutating: true,
    input: { strategyHash: hex32 },
    run: (o, c, a) => closeStrategy(o, c, a),
  });
}
