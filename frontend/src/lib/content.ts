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

export const MCP_TOOLS: { name: string; role: Role; scope: string; effect: string }[] = [
  { name: "register_agent", role: "owner", scope: "agent:admin", effect: "KYARegistry.register, HCS-14 profile · step-up always" },
  { name: "upload_receivable", role: "seller", scope: "receivable:write", effect: "None (pending)" },
  { name: "confirm_receivable", role: "buyer", scope: "receivable:confirm", effect: "ReceivableRegistry.register, NFT mint, HCS" },
  { name: "get_receivable_status", role: "any", scope: "receivable:read", effect: "—" },
  { name: "get_quotes", role: "seller", scope: "credit:read", effect: "—" },
  { name: "open_facility", role: "seller", scope: "facility:open", effect: "CreditFacility.openAndFund · step-up above mandate" },
  { name: "set_budgets", role: "seller", scope: "budget:write", effect: "CreditFacility.setBudgets" },
  { name: "reserve_spend", role: "worker", scope: "spend:reserve", effect: "CreditFacility.reserve · step-up above maxPerTx" },
  { name: "pay_x402", role: "worker", scope: "spend:pay", effect: "x402 settle (co-signed)" },
  { name: "commit_spend", role: "worker", scope: "spend:commit", effect: "CreditFacility.commit" },
  { name: "repay_receivable", role: "buyer", scope: "repay:write", effect: "RepaymentRouter.repay" },
  { name: "explain_decision", role: "any", scope: "credit:read", effect: "AI explanation of a deterministic decision" },
];

export const ERROR_CODES: [string, string][] = [
  ["DUPLICATE_RECEIVABLE", "registry"], ["BAD_BUYER_SIG", "registry"], ["WRONG_PAYEE", "registry"], ["BAD_NONCE", "registry"],
  ["TERM_INELIGIBLE", "registry"], ["KYA_FAIL", "registry"], ["SELF_DEALING", "registry"], ["NOT_CONFIRMED", "facility · opcode"],
  ["BORROWING_BASE_EXCEEDED", "facility"], ["NOT_CHEAPEST_FIRST", "facility"], ["AGENT_BUDGET_EXCEEDED", "engine · facility"], ["TX_LIMIT_EXCEEDED", "engine · facility"],
  ["DAILY_LIMIT_EXCEEDED", "engine · facility"], ["MERCHANT_NOT_ALLOWED", "engine · facility"], ["GLOBAL_CREDIT_LIMIT_EXCEEDED", "engine · facility"], ["RESERVATION_EXPIRED", "facility"],
  ["FACILITY_NOT_ACTIVE", "facility"], ["PAUSED", "facility"], ["INSUFFICIENT_SCOPE", "MCP · 403"], ["KYA_LEVEL_TOO_LOW", "auth server"],
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
];
