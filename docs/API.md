# CashETH MCP server API

`apps/mcp-server` is one Express 5 app with two faces:

- **MCP** (`POST /mcp`): an OAuth 2.1 resource server exposing the CashETH agent tools over stateless Streamable HTTP. Every call needs an access token from the CashETH authorization server (`apps/auth-server`).
- **Read API** (`GET /events`, `/agents`, `/lenders`, `/receivables/:id`, `/health`): unauthenticated JSON for the dashboard (Ruling R14). It returns only hashes, addresses, amounts and states.

Defaults: `MCP_PORT=4030`, `MCP_RESOURCE_URL=http://localhost:4030/mcp`, `AUTH_ISSUER=http://localhost:4020`. Start the authorization server first, then `pnpm -F @casheth/mcp start`.

All USDC amounts are **6-decimal base-unit strings** (`"250000"` is 0.25 USDC). APRs are **percent numbers** (`8.5`). Times are unix seconds unless a field says ISO.

---

## 1. Authorization flow

```
client ──POST /mcp (no token)──────────────▶ 401  WWW-Authenticate: Bearer error="invalid_token",
                                                   resource_metadata="http://localhost:4030/.well-known/oauth-protected-resource/mcp"
client ──GET /.well-known/oauth-protected-resource/mcp ─▶ { resource, authorization_servers: [AUTH_ISSUER], scopes_supported }
client ──POST {AUTH_ISSUER}/token  (RFC 7523 JWT-bearer, or auth code + PKCE for human MCP clients)
          grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer & assertion=<ES256K agent JWT> & resource=<MCP_RESOURCE_URL>
       ◀── { access_token, token_type: "Bearer", expires_in: 600, scope }
client ──POST /mcp  Authorization: Bearer <access_token> ─▶ tools
```

The MCP server verifies each token itself (`src/auth.ts`):

| Check | Rule |
|---|---|
| Signature | ES256 against the AS JWKS (`jwks_uri` from the AS metadata, else `{AUTH_ISSUER}/.well-known/jwks.json`); header `typ` must be `at+jwt` |
| Issuer | exactly `new URL(AUTH_ISSUER).href` (note the trailing slash) |
| Audience | exactly `MCP_RESOURCE_URL`; the SDK middleware checks it again (`expectedResource`). A token for any other resource gets `401 invalid_token`, even though its signature verifies |
| Expiry | `exp` in the future, else `401 invalid_token` "Token has expired" |
| Claims | `sub`, `jti`, `iat`, `exp`, `agent`, `role`, `scope` required |

Identity is the **`agent` claim** (the agent's EVM address). `sub` is the UAID on the JWT-bearer path but the UAID hash on the auth-code path, so nothing is keyed on it; it is only logged (with `jti`) for every call. Tokens are never forwarded to any other service (no token passthrough): the server talks to the chain, the mirror node, HCS and Anthropic with its own credentials.

Protected resource metadata is served at `/.well-known/oauth-protected-resource/mcp` (RFC 9728 path form) and at `/.well-known/oauth-protected-resource`; the AS metadata is mirrored at `/.well-known/oauth-authorization-server`.

### Roles and scopes

Roles come from `KYARegistry` (`role` claim): 1 seller, 2 buyer, 3 worker, 4 lender. Scopes per role at KYA level ≥ 2 (`packages/shared/src/auth.ts` `ROLE_SCOPES`); level 1 gets only the read scopes (`receivable:read`, `credit:read`, `stats:read`); level 0 gets no token.

| Role | Scopes |
|---|---|
| seller | `receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read` |
| buyer | `receivable:confirm receivable:read credit:read repay:write stats:read` |
| worker | `receivable:read credit:read spend:reserve spend:pay spend:commit stats:read` |
| lender | `receivable:read credit:read stats:read lend:write` |
| owner (auth-code path, admin switch) | `agent:admin` in addition |

Each tool checks the scope first, then the role. A failure is a tool result, not an HTTP error:

```json
{ "isError": true, "content": [{ "type": "text", "text": "{\"code\":\"INSUFFICIENT_SCOPE\",\"required\":\"receivable:confirm\",\"requiredRoles\":[\"buyer\"],\"reason\":\"scope\",\"message\":\"token lacks scope receivable:confirm\"}" }] }
```

Tools also check that the caller is the right party (the seller of the receivable, the buyer, the reservation's worker); otherwise `NOT_PARTY`.

---

## 2. MCP transport

`POST /mcp` with `Authorization: Bearer …`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`. The server is **stateless**: every request gets a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, JSON responses), so no `Mcp-Session-Id` is issued and `tools/list` / `tools/call` work without a prior `initialize` on the same connection. `GET` and `DELETE /mcp` answer `405`.

Every tool result is one text content item holding JSON. Errors set `isError: true` and the JSON has a `code`.

### Idempotency

Every mutating tool requires `idempotencyKey` (8–128 chars). The first successful result is stored per `(tool, caller agent, key)` in `DATA_DIR/idempotency.json`; a repeat returns the stored result unchanged (marked with `_meta: { "replayed": true }` on the tool result) and has no side effects. Reusing a key with different arguments returns `IDEMPOTENCY_KEY_REUSED`. Failed calls are not stored, so a retry after an error runs again. Concurrent calls with the same key share one execution.

---

## 3. Tools

| Tool | Role | Scope | Mutating | On-chain / off-chain effect |
|---|---|---|---|---|
| `register_agent` | any (owner) | `agent:admin` | yes | `KYARegistry.register` (KYA issuer key), HCS-14 profile as `AgentRegistered` |
| `upload_receivable` | seller | `receivable:write` | yes | pending record, `ReceivableUploaded` |
| `confirm_receivable` | buyer | `receivable:confirm` | yes | `ReceivableRegistry.register` (coordinator), NFT mint, `ReceivableConfirmed` + `NftMinted` |
| `get_receivable_status` | any | `receivable:read` | no | – |
| `get_quotes` | seller | `credit:read` | no | – (Aqua discovery + solver preview) |
| `open_facility` | seller | `facility:open` | yes | `CreditFacility.openAndFund` (coordinator), `FacilityFunded` |
| `set_budgets` | seller | `budget:write` | yes | `CreditFacility.setBudgets` (seller key) or calldata |
| `reserve_spend` | seller, worker | `spend:reserve` | yes | engine `checkSpend`, then `CreditFacility.reserve` (coordinator), `SpendReserved` / `SpendRejected` |
| `pay_x402` | worker | `spend:pay` | yes | co-signed x402 payment (Hedera transfer) |
| `commit_spend` | worker | `spend:commit` | yes | `CreditFacility.commit` (coordinator), `SpendCommitted` |
| `repay_receivable` | buyer | `repay:write` | yes | `USDC.approve` + `RepaymentRouter.repay` (buyer key) or calldata, `Repaid` |
| `explain_decision` | any | `credit:read` | no | – (AI explains, never decides) |
| `list_agents` | any | `stats:read` | no | – |
| `get_agent_stats` | any | `stats:read` | no | – |
| `fund_agents` | lender | `lend:write` | yes | Aqua `ship` of a credit and optionally a base-yield strategy (lender key) or calldata, `StrategyShipped` |
| `get_lender_yield` | lender | `stats:read` | no | – |
| `close_strategy` | lender | `lend:write` | yes | Aqua `dock` (lender key) or calldata, `StrategyDocked` |

**Who signs.** The server holds the coordinator, co-signer and KYA-issuer keys (`.env.accounts`). Agent keys stay with the agents: `set_budgets`, `repay_receivable`, `fund_agents` and `close_strategy` return `{ mode: "calldata", calls: [{ to, data, description }] }` for the agent to sign and send in order. Only for the demo, `AGENT_KEYS_IN_PROCESS=true` (seller, buyer, workers) and `LENDER_KEYS_IN_PROCESS=true` (lenders) let the server sign with the demo keys and return `{ mode: "sent" | "shipped", txHash, hashscan }`. `pay_x402` needs the worker's half of the 2-of-2 spend-wallet key, so it requires `AGENT_KEYS_IN_PROCESS=true` (else `KEY_NOT_HELD`).

Inputs below omit `idempotencyKey`, which every mutating tool also takes. `hex32` = `0x` + 64 hex chars; `units` = USDC base-unit decimal string.

### `register_agent`
In: `{ account: address, accountId: "0.0.x", name, role: "seller"|"buyer"|"worker"|"lender", level: 0..3, ownerGroup: string (label, hashed) | hex32, mandateHash?: hex32, expiresAt?: unix }`
Out: `{ uaid, account, role, level, txHash, hashscan, hcsSeq }`. The UAID is the HCS-14 id built from the account id; `uaidHash = keccak256(uaid)` goes on-chain.

### `upload_receivable`
In: `{ seller?: address (must be the caller), buyer: address, amount: units, dueDate: unix, buyerRef: hex32 | text (hashed), detailsCommitment: hex32 }`
Out: `{ pendingId, id, confirmationRequest: { typedData } }`. `typedData` is the EIP-712 `ReceivableConfirmation` (domain `AgentReceivables` v1, chain 296, `verifyingContract` = ReceivableRegistry) with `payTo` = RepaymentRouter, the buyer's current `nonce` and a 24 h `deadline`. **uint fields are decimal strings**: convert `amount`, `dueDate`, `nonce`, `deadline` to bigint before signing. `id = keccak256(abi.encode(buyer, buyerRef))`. An already registered id returns `DUPLICATE_RECEIVABLE`.

### `confirm_receivable`
In: `{ pendingId: hex32, signature: 65-byte hex }` (caller must be the buyer)
Checks, in order: signature recovers the buyer (`BAD_BUYER_SIG`), deadline and 1–120 day tenor (`TERM_INELIGIBLE`), nonce unchanged (`BAD_NONCE`), buyer level ≥ 3 and seller level ≥ 2, both unrevoked and unexpired (`KYA_FAIL`), different owner groups (`SELF_DEALING`), not registered (`DUPLICATE_RECEIVABLE`). Each rejection is recorded as `ReceivableRejected`. Then the credit score (`@casheth/engine` `scoreReceivable`), `register` with the coordinator, the NFT mint (metadata `{id, seq}` with the HCS sequence of `ReceivableConfirmed`).
Out: `{ id, txHash, hashscan, nftSerial, nftError?, hcsSeq, hcsError?, decision: { approved, score, advanceBps, limit: units, reasons[] } }`. NFT and HCS failures never fail the call (the receivable is already registered); they come back as `nftError` / `hcsError`.

### `get_receivable_status`
In: `{ id: hex32 }`. Out: the `GET /receivables/:id` object plus `decision` when known. A receivable uploaded but not yet confirmed has `state: "Pending"`.

### `get_quotes`
In: `{ id }` (caller = seller; state must be Confirmed, else `NOT_CONFIRMED`).
Out: `{ id, decision, borrowingBase: units, strategies: [{ maker, strategyHash, kind: "credit"|"base", aprBps?, tier?, sellerSet?, feeBps?, virtualUsdc, realUsdc }], plan: { fills: [{ maker, strategyHash, amount, aprBps }], total, skipped: [{ strategyHash, reason }] } }`. No transaction; the solver quotes each strategy through `router.quote` from the facility, so on-chain lender rules (tier, seller set, per-buyer cap) decide eligibility.

### `open_facility`
In: `{ id }`. Re-solves and sends `openAndFund(id, fills, advanceBps, limit)` with the coordinator.
Out: `{ id, txHash, hashscan, funded, borrowingBase, partial, fills, total, skipped }`. Errors: `CREDIT_DECLINED` (decision not approved), `NO_ELIGIBLE_LIQUIDITY` (empty plan), contract reverts (`NOT_CHEAPEST_FIRST`, `BORROWING_BASE_EXCEEDED`, …).

### `set_budgets`
In: `{ id, budgets: [{ worker, alloc: units, maxPerTx: units, maxDaily: units, merchants: address[] }] }` (caller = facility seller).
Out: `{ id, mode: "calldata", calls }` or `{ id, mode: "sent", txHash, hashscan }`.

### `reserve_spend`
In: `{ id, worker, spendWallet: address (long-zero form of the wallet account), merchant: address, amount: units, ttlSeconds?: 30..3600 (default 600) }`. A worker reserves for itself; a seller for any worker of its facility.
The engine runs `checkSpend` against the on-chain budget, limits, merchant allowlist and facility capacity first (`PAUSED`, `FACILITY_NOT_ACTIVE`, `AGENT_BUDGET_EXCEEDED`, `TX_LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`, `MERCHANT_NOT_ALLOWED`, `GLOBAL_CREDIT_LIMIT_EXCEEDED`), then refuses a second open reservation on the same wallet (`WALLET_BUSY`), then sends `reserve` with the coordinator (a revert maps to the same code names). Rejections are recorded as `SpendRejected` with `stage: "engine" | "contract"` and returned as `{ code, stage }`.
Out: `{ id, spendId, amount, expiry, txHash, hashscan }`; `spendId = keccak256(id ‖ worker ‖ nonce)` with the nonce derived from the caller and idempotency key.

Demo (Ruling R24): the compute worker's 5.5 USDC against a 3.0 budget is `AGENT_BUDGET_EXCEEDED`; the research worker's 0.6 against `maxPerTx` 0.5 is `TX_LIMIT_EXCEEDED`.

### `pay_x402`
In: `{ spendId, url }` (caller = the reservation's worker; reservation open and unexpired).
The worker key signs the facilitator-paid Hedera transfer; the co-signer signs only when the engine's `approvePayment` accepts the `PaymentRequirements` against the open reservation (scheme `exact`, network, USDC asset, `payTo` = the reservation merchant's account, amount ≤ reserved, before expiry, payer = spend wallet) **and** the transaction bytes move exactly that USDC amount from the spend wallet to `payTo` and nothing else.
Out: `{ spendId, transactionId, hashscan, status, body }`. Refusal: `{ code: "COSIGNER_REFUSED", reason: "wrong_payee" | "amount_exceeds_reservation" | "reservation_expired" | "wrong_asset" | "wrong_network" | "wrong_payer" | "amount_mismatch" | … }`, recorded as `SpendRejected` (`stage: "cosigner"`).

### `commit_spend`
In: `{ spendId, hederaTxId: "0.0.x@seconds.nanos" }`. Sends `commit(spendId, keccak256(hederaTxId))` with the coordinator; allowed until `expiry + 1 h` (after that anyone may `release` it, Ruling R25), else `RESERVATION_EXPIRED`.
Out: `{ spendId, txIdHash, txHash, hashscan, payment }` (`payment` = HashScan link of the x402 transfer).

### `repay_receivable`
In: `{ id, amount: units }` (caller = buyer; state Financed, Overdue, Defaulted or Repaid, else `NOT_FINANCED`).
Out: `{ id, mode: "calldata", calls: [approve(router, amount), repay(id, amount)] }` or `{ id, mode: "sent", approveTxHash, txHash, hashscan, toLenders, toSeller, state }`. The approval is always the exact amount (HTS rejects unlimited approvals).

### `explain_decision`
In: `{ id }`. Out: `{ id, decision, decisionSource: "event"|"recomputed", explanation, source: "anthropic"|"template", model? }`. With `ANTHROPIC_API_KEY` the explanation comes from `claude-haiku-5-5` given the decision JSON and the rule list with the system instruction "explain, never change"; otherwise (or on a model error/refusal) a templated explanation with `source: "template"`. The returned `decision` is always the engine's.

### `list_agents`, `get_agent_stats`
In: `{}` / `{ address?: address }` (defaults to the caller). Out: `AgentStats[]` / `AgentStats` (section 4).

### `fund_agents`
In: `{ tier?: "low"|"medium"|"high", args?: { maxTenorDays, maxAdvanceBps, minBuyerOnTime, maxPerBuyer: units, aprBps, minSellerOnTime, maxSellerDefaults, minReserve: units }, sellerSet?: address[] (≤ 3), maxPerBuyer?: units, minReserve?: units, creditUsdc: units, base?: { usdc: units, tUsdt: units, feeBps?: number (default 30) } }` — exactly one of `tier` or `args`.
Tiers (`@casheth/aqua` `LENDER_TIERS`): low 7% (seller ≥ 3 on-time, 0 defaults), medium 8.5% (≥ 1 on-time, 0 defaults), high 13% (≤ 2 defaults); a non-empty `sellerSet` replaces the seller thresholds.
Out: `{ mode: "calldata", tier, aprBps, calls: [USDC approve, tUSDT approve?, ship credit, ship base?], strategies: { credit, base? } }` or `{ mode: "shipped", tier, aprBps, credit: { strategyHash, txHash, hashscan }, base? }`.

### `get_lender_yield`
In: `{ address?: address }` (defaults to the caller). Out: `LenderYield` (section 4).

### `close_strategy`
In: `{ strategyHash }` (one of the caller's open strategies, else `NOT_FOUND`). Out: `{ mode: "calldata", strategyHash, calls }` or `{ mode: "sent", strategyHash, txHash, hashscan }`.

---

## 4. Read API (no auth)

CORS: `Access-Control-Allow-Origin` is echoed for origins in `CORS_ORIGINS` (comma-separated, default `http://localhost:3000`, `*` allows any). Errors are `{ code, message }` with 400 (`BAD_INPUT`), 404 (`NOT_FOUND`), 503 (`NOT_DEPLOYED`) or 500.

### `GET /health`
`{ ok: true, resource, authorizationServer, events: <last seq> }`

### `GET /events` → `AuditEvent[]`
The engine `EventStore` in order (`DATA_DIR/events.jsonl`):

```ts
type AuditEvent = {
  v: 1;
  type: "AgentRegistered" | "ReceivableUploaded" | "ReceivableConfirmed" | "ReceivableRejected" | "NftMinted"
      | "StrategyShipped" | "StrategyDocked" | "FacilityFunded" | "BudgetsSet" | "SpendReserved" | "SpendCommitted"
      | "SpendReleased" | "SpendRejected" | "Repaid" | "Overdue" | "Defaulted" | "Disputed";
  seq: number;          // 1-based, local
  prevSeq: number;      // seq - 1
  ts: string;           // ISO time
  id?: string;          // receivable id
  spendId?: string;
  agent?: string;       // caller EVM address
  agentUaid?: string;   // caller UAID when the token's sub is one
  jti?: string;         // access token id of the call
  amount?: string;      // units
  asset?: string;       // USDC token id
  merchant?: string;
  txId?: string;        // Hedera transaction id
  txHash?: string;      // EVM transaction hash
  hashscan?: string;    // HashScan link of the main transaction
  code?: string;        // rejection code
  hcsSeq?: number;      // HCS sequence number of the same message on HCS_AUDIT_TOPIC_ID
  hcsTxId?: string;
  hcsError?: string;    // set instead of hcsSeq when the HCS publish failed (best-effort)
  [k: string]: unknown; // type-specific fields (decision, fills, workers, strategyHash, ...)
};
```

The same JSON (with `v`, `seq`, `prevSeq`, `ts`; amounts as strings; hashes and addresses only) is published to the HCS audit topic before the local append, serialised so `seq` matches. An HCS message holds 1024 bytes: when an event would not fit, the HCS copy drops, in order, `hashscan`, `paymentHashscan`, `decisionInputs`, `jti`, `agentUaid` (derived links and caller context) until it does; the local event keeps every field. HCS is best-effort: a failed publish leaves `hcsError` on the local event and never fails the tool.

### `GET /agents` → `AgentStats[]`

```ts
type AgentStats = {
  address: string; uaid: string; role: "seller" | "buyer" | "worker" | "lender"; label: string;
  level: number;                 // KYA level
  score: number;                 // scoreReceivable on the agent's own reputation (base score, zero tenor)
  tier: "low" | "medium" | "high" | "none"; // safest lender tier whose seller thresholds the agent meets
  onTimePct: number;             // on-time / (on-time + late + defaults) x 100; 0 without history
  receivablesFunded: number;     // receivables (as seller or buyer) that reached Financed
  receivablesRepaid: number;
  receivablesDefaulted: number;
  avgDaysToRepay: number;        // Financed -> Repaid, days, 1 decimal; 0 if none
  spendByMerchant: Record<string, string>; // merchant EVM address -> committed units (worker's own, or all workers on the seller's facilities)
  lenderReturnPct: number;       // lenders: (creditFees + baseFees) / capital x 100; others 0
};
```

Agents are the demo accounts from `.env.accounts` (UAIDs from `<PREFIX>_UAID`) plus anyone added through `register_agent`.

### `GET /lenders` → `LenderYield[]`

```ts
type LenderYield = {
  address: string; label: string;
  tier: "low" | "medium" | "high" | "custom" | "none"; // from the cheapest open credit strategy's aprBps
  capital: string;     // idle + lent
  lent: string;        // Σ PositionOpened.principal - Σ LenderPaid.principal
  idle: string;        // wallet USDC balance
  baseFees: string;    // Σ Aqua Pushed (USDC/tUSDT) into the lender's strategies x base feeBps
  creditFees: string;  // Σ LenderPaid.fee
  baseApr: number;     // baseFees / base strategy balance, annualised since its first swap ("scripted volume")
  boostApr: number;    // credit strategy aprBps / 100
  blendedApr: number;  // (baseApr x idle + boostApr x lent) / capital
  strategies: { credit?: string; base?: string }; // open strategy hashes
};
```

Stats come from the in-process `BasicStatsProvider` (registry, facility, router and Aqua logs via the mirror node, cached 10 s); Task 6.5 swaps in `packages/stats` behind the same shapes.

### `GET /receivables/:id`

```ts
type ReceivableDetails = {
  id: string;
  state: "Pending" | "Confirmed" | "Financed" | "Repaid" | "Overdue" | "Defaulted" | "Cancelled";
  seller: string; buyer: string;
  amount: string;     // face value, units
  dueDate: number;    // unix seconds
  funded: string;     // facility funded amount
  debt: string;       // RepaymentRouter.lenderDue (principal + fee still owed to lenders)
  positions: Array<{ maker: string; principal: string; aprBps: number; fee: string /* paid + currently due */ }>;
  evidence: Array<{ label: string; url: string }>; // HashScan links of every event for this id (tx, HCS message, NFT)
};
```

`400` for a malformed id, `404` for an id that is neither registered nor pending.

---

## 5. Error codes

Tool errors are `{ code, message, ...details }`. The codes are the shared names (BUILD.md §12.2; the contracts revert with the same names):

`DUPLICATE_RECEIVABLE`, `BAD_BUYER_SIG`, `WRONG_PAYEE`, `BAD_NONCE`, `TERM_INELIGIBLE`, `KYA_FAIL`, `SELF_DEALING`, `NOT_CONFIRMED`, `BORROWING_BASE_EXCEEDED`, `NOT_CHEAPEST_FIRST`, `AGENT_BUDGET_EXCEEDED`, `TX_LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`, `MERCHANT_NOT_ALLOWED`, `GLOBAL_CREDIT_LIMIT_EXCEEDED`, `RESERVATION_EXPIRED`, `FACILITY_NOT_ACTIVE`, `PAUSED`, `INSUFFICIENT_SCOPE`, `KYA_LEVEL_TOO_LOW`, `NOT_PARTY`, `WALLET_BUSY`, `RESERVATION_NOT_OPEN`, `BUDGETS_EXCEED_FUNDED`, `NOT_FINANCED`, `ZERO_AMOUNT`, `SELLER_NOT_FUNDED_BY_LENDER`, `LENDER_RESERVE_TOO_LOW`, plus any other custom error a contract reverts with (decoded by name).

MCP-side codes:

| Code | Meaning |
|---|---|
| `INSUFFICIENT_SCOPE` | token lacks the tool's scope (`reason: "scope"`) or role (`reason: "role"`); `required`, `requiredRoles` |
| `NOT_PARTY` | the caller is not the seller / buyer / worker this call is about |
| `BAD_INPUT` | malformed id, address, amount or URL (`field`) |
| `NOT_FOUND` | unknown pending id, receivable or strategy |
| `NOT_DEPLOYED` | `deployments/testnet/addresses.json` lacks a contract the call needs (read at runtime) |
| `IDEMPOTENCY_KEY_REUSED` | same key, different arguments |
| `CREDIT_DECLINED` | the credit decision is not approved (`reasons`) |
| `NO_ELIGIBLE_LIQUIDITY` | no lender strategy can fund the receivable (`skipped`) |
| `COSIGNER_REFUSED` | the policy co-signer refused the x402 payment (`reason`) |
| `PAYMENT_FAILED` | the merchant answered without a settlement (`status`, `body`) |
| `KEY_NOT_HELD` | the server would need an agent key it does not hold (demo flags off) |
| `CHAIN_ERROR` | an RPC failure or an undecodable revert |
| `INTERNAL` | anything else |

HTTP-level errors on `/mcp` come from the SDK bearer middleware: `401 { error: "invalid_token", error_description }` with `WWW-Authenticate: Bearer error="invalid_token", error_description="…", resource_metadata="…"` (missing, malformed, expired, wrong-issuer, wrong-audience or badly signed token); `405` for `GET`/`DELETE`.

---

## 6. Configuration

| Variable | Default | Use |
|---|---|---|
| `MCP_PORT` | `4030` | listen port |
| `MCP_RESOURCE_URL` | `http://localhost:4030/mcp` | token audience and MCP path |
| `AUTH_ISSUER` | `http://localhost:4020` | authorization server (metadata fetched at boot, issuer must match) |
| `COORDINATOR_KEY`, `COSIGNER_KEY` | required | coordinator writes; x402 co-signature |
| `KYA_ISSUER_KEY` | – | `register_agent` |
| `HCS_AUDIT_TOPIC_ID`, `RECEIVABLE_NFT_TOKEN_ID` | `deployments/testnet/hedera.json` | audit topic, receivable NFT collection (operator key submits and mints) |
| `DATA_DIR` | `apps/mcp-server/data` | `events.jsonl`, `idempotency.json`, `pending.json` |
| `CORS_ORIGINS` | `http://localhost:3000` | read API browser origins |
| `ANTHROPIC_API_KEY` | – | `explain_decision` via `claude-haiku-5-5` |
| `AGENT_KEYS_IN_PROCESS` | `false` | demo: sign as seller/buyer/workers |
| `LENDER_KEYS_IN_PROCESS` | `false` | demo: sign as lenders |
| `AQUA_FROM_BLOCK` | swap router creation block | first block for Aqua log discovery |

Contract addresses are read from `deployments/testnet/addresses.json` on every call, never hard-coded.
