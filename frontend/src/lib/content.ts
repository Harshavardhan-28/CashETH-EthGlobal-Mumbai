export type Role = "seller" | "buyer" | "worker" | "lender" | "owner" | "any";

export const ROLE_COLOR: Record<Role, string> = {
  seller: "var(--seller)",
  buyer: "var(--buyer)",
  worker: "var(--worker)",
  lender: "var(--lender)",
  owner: "var(--ink)",
  any: "rgb(var(--ink-rgb) / 0.35)",
};

/* ---------- Landing ---------- */

export type LifecycleStep = {
  n: string;
  actor: string;
  /** CSS background for the actor swatch; `outline` renders a hollow square. */
  swatch: string;
  outline?: boolean;
  title: string;
  code: string;
  body: string;
};

export const LIFECYCLE: LifecycleStep[] = [
  { n: "01", actor: "Seller", swatch: "var(--seller)", title: "Upload", code: "upload_receivable", body: "Gets a pending ID and a confirmation request for the buyer agent." },
  { n: "02", actor: "Buyer", swatch: "var(--buyer)", title: "Confirm", code: "confirm_receivable", body: "Signs an EIP-712 confirmation that names the repayment router as payee." },
  { n: "03", actor: "Orchestrator", swatch: "var(--ink)", outline: true, title: "Verify", code: "sig · KYA · dedupe · score", body: "Checks owner separation, dedupes the canonical ID, computes the borrowing base." },
  { n: "04", actor: "Hedera", swatch: "var(--ink)", title: "Register", code: "ReceivableRegistry.register", body: "State becomes Confirmed. Receivable NFT minted, event logged to HCS." },
  { n: "05", actor: "Lenders", swatch: "var(--lender)", title: "Ship", code: "aqua.ship(strategy)", body: "Each lender sets APR, max advance, max tenor and a minimum buyer reputation." },
  { n: "06", actor: "Seller", swatch: "var(--seller)", title: "Fund", code: "open_facility", body: "The modified SwapVM fills the cheapest eligible strategies first. No partial funding." },
  { n: "07", actor: "Workers", swatch: "var(--worker)", title: "Spend", code: "reserve → pay_x402 → commit", body: "Exactly the reserved USDC moves to a co-signed spend wallet and settles via x402." },
  { n: "08", actor: "Buyer", swatch: "var(--buyer)", title: "Repay", code: "repay_receivable", body: "Lenders take principal plus fee first. The seller agent gets the rest. Reputation updates on-chain." },
];

export const HOW_STEPS = [
  {
    n: "01",
    title: "Invoice in",
    label: "Invoice in",
    body: "Your seller agent uploads an invoice. The buyer's agent signs it - that signature is what makes it financeable.",
    tools: ["upload_receivable", "confirm_receivable"],
  },
  {
    n: "02",
    title: "Capital out",
    label: "Capital out",
    body: "Lenders compete through 1inch Aqua. The cheapest capital fills first, up to 75% of the invoice.",
    tools: ["open_facility"],
  },
  {
    n: "03",
    title: "Agents spend",
    label: "Agents spend",
    body: "Worker agents pay for APIs and compute over x402 - always inside budgets carved from what was funded.",
    tools: ["reserve_spend", "pay_x402"],
  },
  {
    n: "04",
    title: "Lenders repaid",
    label: "Repaid",
    body: "When the buyer pays, the router repays lenders first. Whatever is left goes back to your agent.",
    tools: ["repay_receivable"],
  },
] as const;

export const PRINCIPLES = [
  "The buyer's signature is the root of trust.",
  "Every limit is checked twice.",
  "AI explains. It never approves.",
] as const;

/* ---------- Docs ---------- */

export const DOC_NAV = {
  start: [
    ["overview", "Overview"],
    ["quickstart", "Quickstart"],
    ["connect", "Connect an agent"],
    ["architecture", "Architecture"],
  ],
  concepts: [
    ["agents", "Agents & KYA"],
    ["receivables", "Receivables"],
    ["facility", "Credit facility"],
    ["aqua", "Aqua & SwapVM"],
    ["x402", "x402 spending"],
    ["waterfall", "Repayment waterfall"],
  ],
  ref: [
    ["mcp", "MCP tools"],
    ["read-api", "Read API"],
    ["errors", "Error codes"],
    ["config", "Configuration"],
  ],
} as const;

export const ARCHITECTURE: { layer: string; component: string; job: string }[] = [
  { layer: "Access", component: "MCP server", job: "Tool surface for every agent. OAuth 2.1 resource server; scopes and roles per tool." },
  { layer: "Brain", component: "Orchestrator", job: "Verify and dedupe, credit score, KYA, two-phase spend, coordinator signer, co-signer, event log." },
  { layer: "EVM", component: "ReceivableRegistry", job: "Verifies the EIP-712 confirmation. Canonical ID. State machine." },
  { layer: "EVM", component: "CreditFacility", job: "Funds through Aqua, holds USDC, manages budgets and reservations, schedules checks." },
  { layer: "EVM", component: "RepaymentRouter", job: "Takes the buyer's payment and runs the waterfall." },
  { layer: "EVM", component: "AquaCreditSwapVMRouter", job: "Official Aqua plus SwapVM with the credit opcode." },
  { layer: "Native", component: "HTS · HCS · HSS", job: "USDC and receivable NFT · audit topic · scheduled overdue and default checks." },
];

export const KYA_LEVELS = [
  { level: "0", text: "Unknown key. Nothing allowed.", color: "var(--faint-2)" },
  { level: "1", text: "Key proven, UAID registered. Read tools only.", color: "var(--muted)" },
  { level: "2", text: "Owner KYC/KYB hash plus a signed mandate. Sellers borrow; workers spend.", color: "var(--ink)" },
  { level: "3", text: "External KYA attestation or repayment history. Required to act as a buyer.", color: "var(--accent)", highlight: true },
];

export const FAKE_BUYER_CONTROLS = [
  ["Owner separation", "ownerGroup(buyer) ≠ ownerGroup(seller), enforced in register."],
  ["Reputation threshold", "Repayments update reputation on-chain and on HCS."],
  ["Per-buyer exposure cap", "In the borrowing base and in every lender's strategy."],
];

export const REGISTRY_RULES: [string, string][] = [
  ["state[id] == None", "DUPLICATE_RECEIVABLE"],
  ["ECDSA.recover(typed data) == buyer", "BAD_BUYER_SIG"],
  ["payTo == repaymentRouter", "WRONG_PAYEE"],
  ["Before deadline; due date within 1–120 days", "TERM_INELIGIBLE"],
  ["nonces[buyer] == nonce, then increment", "BAD_NONCE"],
  ["Buyer KYA ≥ 3, seller ≥ 2, neither revoked", "KYA_FAIL"],
  ["ownerGroup(buyer) ≠ ownerGroup(seller)", "SELF_DEALING"],
];

export const INVARIANTS = [
  "debt(id) ≤ borrowingBase(id)",
  "Σ budgets ≤ funded",
  "seller gets 0 while any lender is owed",
  "committed + reserved + available = funded",
];

export const X402_STEPS = [
  { label: "01 RESERVE", body: "Limits checked twice. Exactly the amount moves to the spend wallet.", accent: true },
  { label: "02 PAY", body: "Co-signer signs only if payTo, asset and amount match the reservation.", accent: true },
  { label: "03 COMMIT", body: "Hedera tx ID recorded on-chain and to HCS.", accent: true },
  { label: "— RELEASE", body: "On timeout, unspent USDC is pulled back via allowance.", accent: false },
];

export type McpTool = { name: string; roles: Role[]; scope: string; mutating: boolean; effect: string };

/** All 21 tools, in `apps/mcp-server/src/tools.ts` order, with its roles and scopes (docs/API.md §3). */
export const MCP_TOOLS: McpTool[] = [
  { name: "register_agent", roles: ["owner"], scope: "agent:admin", mutating: true, effect: "KYARegistry.register by the KYA issuer · HCS-14 profile as AgentRegistered" },
  { name: "upload_invoice_document", roles: ["seller"], scope: "receivable:write", mutating: true, effect: "Stores the invoice file and reads its fields · InvoiceDocumentStored (hashes only) · optional HFS copy" },
  { name: "get_invoice_document", roles: ["any"], scope: "receivable:read", mutating: false, effect: "—" },
  { name: "upload_receivable", roles: ["seller"], scope: "receivable:write", mutating: true, effect: "Pending record + EIP-712 confirmation request · ReceivableUploaded" },
  { name: "confirm_receivable", roles: ["buyer"], scope: "receivable:confirm", mutating: true, effect: "ReceivableRegistry.register · receivable NFT mint · ReceivableConfirmed + NftMinted" },
  { name: "get_receivable_status", roles: ["any"], scope: "receivable:read", mutating: false, effect: "—" },
  { name: "get_quotes", roles: ["seller"], scope: "credit:read", mutating: false, effect: "— (Aqua discovery + solver preview)" },
  { name: "open_facility", roles: ["seller"], scope: "facility:open", mutating: true, effect: "CreditFacility.openAndFund, cheapest strategies first · FacilityFunded" },
  { name: "set_budgets", roles: ["seller"], scope: "budget:write", mutating: true, effect: "CreditFacility.setBudgets (seller key, or calldata to sign)" },
  { name: "reserve_spend", roles: ["seller", "worker"], scope: "spend:reserve", mutating: true, effect: "Engine checkSpend, then CreditFacility.reserve · SpendReserved / SpendRejected" },
  { name: "pay_x402", roles: ["worker"], scope: "spend:pay", mutating: true, effect: "Co-signed x402 payment (Hedera transfer) to an allowed merchant origin" },
  { name: "commit_spend", roles: ["worker"], scope: "spend:commit", mutating: true, effect: "CreditFacility.commit · SpendCommitted" },
  { name: "release_spend", roles: ["seller", "worker"], scope: "spend:reserve", mutating: true, effect: "CreditFacility.release of an expired reservation · SpendReleased" },
  { name: "repay_receivable", roles: ["buyer"], scope: "repay:write", mutating: true, effect: "USDC.approve + RepaymentRouter.repay, lenders first · Repaid" },
  { name: "explain_decision", roles: ["any"], scope: "credit:read", mutating: false, effect: "— (AI explains a deterministic decision, never makes one)" },
  { name: "list_agents", roles: ["any"], scope: "stats:read", mutating: false, effect: "—" },
  { name: "get_agent_stats", roles: ["any"], scope: "stats:read", mutating: false, effect: "—" },
  { name: "whoami", roles: ["any"], scope: "stats:read", mutating: false, effect: "— (the caller's address, role, KYA level and scopes from its token; no chain reads)" },
  { name: "fund_agents", roles: ["lender"], scope: "lend:write", mutating: true, effect: "Aqua ship of a credit (and optional base-yield) strategy · StrategyShipped" },
  { name: "get_lender_yield", roles: ["lender"], scope: "stats:read", mutating: false, effect: "—" },
  { name: "close_strategy", roles: ["lender"], scope: "lend:write", mutating: true, effect: "Aqua dock · StrategyDocked" },
];

/** Scopes a token carries per role at KYA level ≥ 2 (level 1: read scopes only; level 0: no token). */
export const ROLE_SCOPES: [Role, string][] = [
  ["seller", "receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read"],
  ["buyer", "receivable:confirm receivable:read credit:read repay:write stats:read"],
  ["worker", "receivable:read credit:read spend:reserve spend:pay spend:commit stats:read"],
  ["lender", "receivable:read credit:read stats:read lend:write"],
  ["owner", "agent:admin (the KYA issuer only, JWT-bearer grant)"],
];

/** The unauthenticated read API (docs/API.md §4): hashes, addresses, amounts and states only. */
export const READ_API: { method: "GET"; path: string; returns: string }[] = [
  { method: "GET", path: "/health", returns: "{ ok, resource, authorizationServer, events } — liveness and the audit event count" },
  { method: "GET", path: "/events", returns: "AuditEvent[] — every state change and rejection, oldest first, each mirrored on the HCS audit topic" },
  { method: "GET", path: "/agents", returns: "AgentStats[] — KYA level, score, tier, on-time %, receivables funded / repaid / defaulted, spend by merchant" },
  { method: "GET", path: "/lenders", returns: "LenderYield[] — capital, lent, idle, base / boost / blended APR, open strategies" },
  { method: "GET", path: "/receivables/:id", returns: "State, amount funded and the lenders owed for one receivable" },
  { method: "GET", path: "/invoices/:keccak256", returns: "The invoice file itself, so anyone can hash it against the registry's detailsCommitment" },
];

export const ERROR_CODES: [string, string][] = [
  ["DUPLICATE_RECEIVABLE", "registry"], ["BAD_BUYER_SIG", "registry"], ["WRONG_PAYEE", "registry"], ["BAD_NONCE", "registry"],
  ["TERM_INELIGIBLE", "registry"], ["KYA_FAIL", "registry"], ["SELF_DEALING", "registry"], ["NOT_CONFIRMED", "facility · opcode"],
  ["BORROWING_BASE_EXCEEDED", "facility"], ["NOT_CHEAPEST_FIRST", "facility"], ["AGENT_BUDGET_EXCEEDED", "engine · facility"], ["TX_LIMIT_EXCEEDED", "engine · facility"],
  ["DAILY_LIMIT_EXCEEDED", "engine · facility"], ["MERCHANT_NOT_ALLOWED", "engine · facility"], ["GLOBAL_CREDIT_LIMIT_EXCEEDED", "engine · facility"], ["RESERVATION_EXPIRED", "facility"],
  ["FACILITY_NOT_ACTIVE", "facility"], ["PAUSED", "facility"], ["NOT_PARTY", "facility · MCP"], ["WALLET_BUSY", "facility"],
  ["RESERVATION_NOT_OPEN", "facility"], ["BUDGETS_EXCEED_FUNDED", "facility"], ["NOT_FINANCED", "repayment router"], ["ZERO_AMOUNT", "repayment router"],
  ["SELLER_NOT_FUNDED_BY_LENDER", "Aqua opcode"], ["LENDER_RESERVE_TOO_LOW", "Aqua opcode"], ["INSUFFICIENT_SCOPE", "MCP · scope check"], ["KYA_LEVEL_TOO_LOW", "auth server"],
];

/** MCP-side codes (`McpErrorCode`): a tool error's `code` is a shared code above or one of these. */
export const MCP_ERROR_CODES: [string, string][] = [
  ["INSUFFICIENT_SCOPE", "The token lacks the tool's scope or role (reason: scope | role)"],
  ["NOT_PARTY", "The caller is not the seller, buyer or worker this call is about"],
  ["BAD_INPUT", "Malformed id, address, amount or URL (field)"],
  ["INVOICE_MISMATCH", "The invoice document's printed terms differ from the submitted ones"],
  ["NOT_FOUND", "Unknown pending id, receivable or strategy"],
  ["NOT_DEPLOYED", "addresses.json lacks a contract the call needs"],
  ["IDEMPOTENCY_KEY_REUSED", "Same idempotency key, different arguments"],
  ["CREDIT_DECLINED", "The deterministic credit decision is not approved (reasons)"],
  ["NO_ELIGIBLE_LIQUIDITY", "No lender strategy can fund the receivable (skipped)"],
  ["SPEND_WALLET_NOT_REGISTERED", "reserve_spend wallet is not the worker's registered 2-of-2 with the co-signer"],
  ["MERCHANT_URL_NOT_ALLOWED", "pay_x402 URL origin is not configured for the reservation's merchant"],
  ["COSIGNER_REFUSED", "The policy co-signer refused the x402 payment (reason)"],
  ["PAYMENT_FAILED", "The merchant answered without a settlement"],
  ["PAYMENT_IN_FLIGHT", "A payment for this reservation is in flight or was co-signed without a seen settlement"],
  ["RESERVATION_PAID", "release_spend on a reservation pay_x402 settled: commit it instead"],
  ["RESERVATION_NOT_EXPIRED", "release_spend before the reservation's expiry"],
  ["ALREADY_REPAID", "repay_receivable on a receivable that is already Repaid"],
  ["KEY_NOT_HELD", "The server would need an agent key it does not hold (demo flags off)"],
  ["CONTRACT_REVERTED", "A contract reverted with a custom error outside the shared list (error, args)"],
  ["CHAIN_ERROR", "An RPC failure or an undecodable revert"],
  ["INTERNAL", "Anything else"],
];

export const CONFIG: [string, string][] = [
  ["Network", "Hedera testnet · EVM chain ID 296"],
  ["JSON-RPC relay", "https://testnet.hashio.io/api"],
  ["Mirror node", "https://testnet.mirrornode.hedera.com/api/v1"],
  ["USDC (testnet)", "0.0.429274 · 0x0000000000000000000000000000000000068cda · 6 dp"],
  ["WHBAR", "0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed · 8 dp"],
  ["System contracts", "HTS 0x167 · HAS 0x16a · HSS 0x16b"],
  ["x402 facilitators", "api.testnet.blocky402.com · x402.org/facilitator · testnet.facilitator.launa.dev"],
  ["Explorer", "https://hashscan.io/testnet"],
  ["MCP endpoint", "http://localhost:4030/mcp · POST · stateless Streamable HTTP"],
  ["Read API", "http://localhost:4030 · GET · no auth"],
  ["Authorization server", "http://localhost:4020"],
  ["HCS audit topic", "0.0.11338927"],
  ["Receivable NFT", "0.0.11338934"],
];

/** MCP server environment (docs/API.md §6). */
export const MCP_ENV: [string, string, string][] = [
  ["MCP_PORT", "4030", "Listen port"],
  ["HOST", "127.0.0.1", "Interface the MCP and authorization servers bind to"],
  ["MCP_RESOURCE_URL", "http://localhost:4030/mcp", "Token audience and MCP path"],
  ["AUTH_ISSUER", "http://localhost:4020", "Authorization server; metadata fetched at boot, issuer must match"],
  ["COORDINATOR_KEY, COSIGNER_KEY", "required", "Coordinator writes; x402 co-signature"],
  ["KYA_ISSUER_KEY", "—", "register_agent"],
  ["HCS_AUDIT_TOPIC_ID, RECEIVABLE_NFT_TOKEN_ID", "deployments/testnet/hedera.json", "Audit topic and receivable NFT collection"],
  ["DATA_DIR", "apps/mcp-server/data", "events.jsonl, idempotency.json, pending.json, invoices/"],
  ["CORS_ORIGINS", "http://localhost:3000", "Browser origins allowed on the read API (add the admin console's origin)"],
  ["ANTHROPIC_API_KEY", "—", "explain_decision via claude-haiku-5-5"],
  ["HFS_ENABLED", "false", "Also store invoice documents on the Hedera File Service"],
  ["CASHETH_LLM_PROVIDER", "— (probe)", "ollama forces the local model for invoice field extraction"],
  ["OLLAMA_BASE_URL, CASHETH_LLM_MODEL", "http://localhost:11434, qwen2.5:7b", "Ollama OpenAI-compatible endpoint"],
  ["AGENT_KEYS_IN_PROCESS", "false", "Demo: the server signs as seller, buyer and workers (true), or only the listed roles (seller,worker); other roles get calldata"],
  ["LENDER_KEYS_IN_PROCESS", "false", "Demo: the server signs as lenders"],
  ["AQUA_FROM_BLOCK", "swap router creation block", "First block for Aqua log discovery"],
  ["MERCHANT_ORIGINS", "—", "Extra accountId=origin pairs: the only origins pay_x402 fetches"],
];
