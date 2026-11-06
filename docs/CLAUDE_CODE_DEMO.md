# Claude Code as the seller agent

Claude Code plays the seller agent, the main character of the pitch. It wants data from a paid API, gets `402 Payment Required`, has no cash, so it raises working capital against an invoice its customer owes, buys the data over x402 with that credit, and settles the loan when the customer pays. Every step is a real Hedera testnet transaction.

Claude Code signs in once, as the seller. Its counterparties run inside the CashETH server with their own keys:

| Party | Who drives it | Signs with |
|---|---|---|
| Seller (main agent) | Claude Code, through `casheth-seller` | the seller key, held by the server for the demo |
| Buyer (the customer) | the seller's `request_buyer_confirmation` and `settle_receivable` | the buyer's own key: EIP-712 confirmation, repayment |
| Worker | the seller's `buy_with_credit` | 2-of-2 spend wallet: worker key + policy co-signer |
| Lenders | nobody: their Aqua strategies are filled by `open_facility` | their earlier `ship` |

The demo sign-in has no owner login: whoever reaches the consent page can act as any demo agent. It is off unless `AUTH_DEMO_GRANT=true`, and both servers listen on `127.0.0.1` only. Never enable it on a public host.

## 1. Build and start the servers

From the repo root, with `.env` and `.env.accounts` in place. Build first: workspace packages import each other's compiled `dist/`.

```bash
pnpm -r build
```

Then one terminal each:

```bash
AUTH_DEMO_GRANT=true pnpm -F @casheth/auth start                                     # :4020

AGENT_KEYS_IN_PROCESS=true \
MERCHANT_ORIGINS=0.0.11333304=https://casheth-paid-apis-177290233934.asia-southeast1.run.app \
pnpm -F @casheth/mcp start                                                           # :4030
```

- `AGENT_KEYS_IN_PROCESS=true`: the server holds the seller, buyer and worker keys, so the counterparties can act. The co-signer still checks every payment against its reservation.
- `MERCHANT_ORIGINS`: the only origin `pay_x402` may fetch for the paid API's payee `0.0.11333304`.

## 2. Sign in once

Start Claude Code in the repo root and approve `casheth-seller` from `.mcp.json`. Then sign in, either with `/mcp` → `casheth-seller` → Authenticate, or from a terminal:

```bash
export CLAUDE_CONFIG_DIR=/Users/harsh/.claude-antigravity   # only if your Claude Code uses a custom config dir
claude mcp login casheth-seller
```

The consent page pre-selects the seller; click **Act as seller**. The token carries only the seller's scopes and refreshes on its own for 8 hours.

## 3. Run

```text
/casheth-demo
```

or `/casheth-demo PO-MYREF 1.20`, or ask: "use the casheth-operator agent to raise credit against a new invoice and buy the HBAR price feed". A new buyer reference is needed each run (a reused one is rejected as a duplicate invoice). Keep the invoice near 1.20 USDC: the advance is 75% and the lenders' remaining credit is about 1 USDC.

The run: `whoami` → the paid API's 402 → a fresh invoice PDF → `upload_invoice_document` → `upload_receivable` → `request_buyer_confirmation` → `open_facility` (no negotiation: shared liquidity, cheapest lenders first) → `set_budgets` → `buy_with_credit` (reserve, x402 pay, commit) → `settle_receivable` → `get_receivable_status` = `Repaid`, then a table of HashScan links.

## 4. Evidence

```bash
curl -s http://localhost:4030/events | jq -c '.[-12:] | .[] | {type, id, hashscan, paymentHashscan, hcsSeq}'
```

`SpendCommitted.paymentHashscan` is the x402 USDC transfer from the worker's spend wallet to the merchant; `Repaid` carries the waterfall (lenders first, the seller the rest). Every event is also on the HCS audit topic.

## Non-custodial variant

The buyer does not have to be server-run. `wallet-mcp/` is a local stdio MCP wallet that holds the buyer key on your machine, signs the EIP-712 confirmation (`sign_receivable_confirmation`) and sends the repayment calldata `repay_receivable` returns when the server does not hold the buyer key (`send_calls`, allowlisted targets, capped exact approvals). To use it, add it to `.mcp.json` as a stdio server (`pnpm -s -F @casheth/wallet-mcp start`, env `WALLET_ACCOUNTS=buyer`), start the MCP server with `AGENT_KEYS_IN_PROCESS=seller,worker`, and sign in a second server entry as the buyer.
