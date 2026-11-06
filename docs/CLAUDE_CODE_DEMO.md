# Claude Code as the CashETH agent

Claude Code runs the whole CashETH lifecycle on Hedera testnet through MCP, with no agent code of ours in the loop: it uploads a new invoice as the seller, gets the buyer's EIP-712 confirmation signed by a local wallet, finances the receivable, buys data from an external x402 API as the research worker, and repays as the buyer from the buyer's own key. `/casheth-demo` runs it end to end and prints every HashScan link.

The demo grant has no owner login: whoever reaches the consent page can act as any demo agent. It is off unless `AUTH_DEMO_GRANT=true`, and both servers listen on `127.0.0.1` only. Never enable it on a public host.

## How Claude Code reaches the wallet

```
Claude Code ──OAuth (one token per server name)──▶ casheth-seller ┐
            ──────────────────────────────────────▶ casheth-buyer  ├─▶ MCP server :4030 ──▶ Hedera testnet
            ──────────────────────────────────────▶ casheth-worker ┘   (coordinator, co-signer, seller, worker half)
            ──stdio (child process)───────────────▶ casheth-wallet ──▶ Hedera testnet (buyer key, never leaves it)
```

| Server (`.mcp.json`) | What it is | Keys |
|---|---|---|
| `casheth-seller`, `casheth-buyer`, `casheth-worker` | The CashETH MCP server (`http://localhost:4030/mcp`) under three names, each pinned to one role's scopes (`oauth.scopes`) | none on the client side: an OAuth token per name |
| `casheth-wallet` | `wallet-mcp/`, a local stdio MCP server Claude Code launches (`pnpm -s -F @casheth/wallet-mcp start`) | the buyer's key from `.env.accounts` (`WALLET_ACCOUNTS=buyer` in `.mcp.json`) |
| `casheth` | The original single server entry, kept for the one-role walkthrough at the end | – |

**One token per role.** Claude Code stores MCP OAuth credentials per server *name*: the key is `<name>|<sha256 of {type, url, headers}>` (read from the Claude Code 2.1.287 client; its docs say sign-ins are stored "per endpoint", which is the name plus that config). Three names on the same URL therefore hold three independent tokens, so one session can act as seller, buyer and worker at once. Each entry pins its role's scopes, Claude Code requests exactly those, and the consent page lists the agents whose role covers them first, with the button focused.

**Who signs what.**

| Action | Signer | Where the key is |
|---|---|---|
| Receivable registration, `openAndFund`, `reserve`, `commit`, HCS, NFT | coordinator | MCP server |
| `set_budgets` | seller | MCP server (`AGENT_KEYS_IN_PROCESS=seller,...`) |
| x402 payment | worker half + policy co-signer (2-of-2) | MCP server: the co-signer signs only a payment matching an open reservation |
| Buyer's EIP-712 confirmation | buyer | `casheth-wallet` (`sign_receivable_confirmation`) |
| Repayment (`approve` exact amount + `RepaymentRouter.repay`) | buyer | `casheth-wallet` (`send_calls`); the server only returns calldata |

**Wallet guardrails** (`wallet-mcp/src/policy.ts`). Tools: `list_accounts` (label, Hedera id, EVM address; never a key), `sign_receivable_confirmation`, `send_calls`, `get_balances`. It signs a confirmation only for the `AgentReceivables` v1 domain on chain 296 whose `verifyingContract` is the ReceivableRegistry in `deployments/testnet/addresses.json`, as the buyer the message names, paying the RepaymentRouter in USDC. It sends calldata only to USDC / tUSDT (`approve`, exact, to the RepaymentRouter or Aqua, never unlimited, at most `WALLET_APPROVE_CAP_USDC` per call, default 20), the RepaymentRouter (`repay`) and Aqua (`ship`, `dock`); the whole batch is checked before anything is sent, each call is dry-run before it is signed, calls go out one at a time, the first failure stops the batch (`CALL_FAILED` with what was already sent), and an identical batch sent again replays the first answer instead of paying twice. It never holds the coordinator, co-signer, KYA-issuer or worker keys.

## 1. Start the servers

From the repo root, with `.env` and `.env.accounts` in place, one terminal each:

```bash
AUTH_DEMO_GRANT=true pnpm -F @casheth/auth start                                     # :4020

AGENT_KEYS_IN_PROCESS=seller,worker \
MERCHANT_ORIGINS=0.0.11333304=https://casheth-paid-apis-177290233934.asia-southeast1.run.app \
pnpm -F @casheth/mcp start                                                           # :4030
```

- `AGENT_KEYS_IN_PROCESS=seller,worker`: the server signs the seller's `set_budgets` and the worker's half of the 2-of-2 spend wallet. The buyer is left out on purpose, so `repay_receivable` answers with calldata for the wallet (`true` would make the server repay itself).
- `MERCHANT_ORIGINS`: the only origin `pay_x402` may fetch for the paid API's payee `0.0.11333304` (`docs/API.md` section 6).
- `LENDER_KEYS_IN_PROCESS` stays off: the lenders' strategies are already shipped.
- The local merchant (`pnpm -F @casheth/merchant start`, :3003) is only needed for the one-role walkthrough at the end.

`casheth-wallet` is not started by hand: Claude Code launches it.

## 2. Approve the MCP servers

Start Claude Code in the repo root (`claude`). It asks to approve the project servers from `.mcp.json`; approve `casheth-seller`, `casheth-buyer`, `casheth-worker` and `casheth-wallet` (and `casheth` if you want the one-role walkthrough). `claude mcp list` shows them; the three remote ones show as needing authentication until step 3.

## 3. Authenticate each role

In Claude Code run `/mcp`, choose `casheth-seller`, then **Authenticate** (or, from a shell, `claude mcp login casheth-seller`). The browser opens the CashETH consent page with the seller pre-selected under "Matches the requested scopes"; click **Act as seller**. Repeat for:

- `casheth-buyer`: **Act as buyer**.
- `casheth-worker`: **Act as worker** on the row for the research worker `0xbead36c554746b00eb2a3b87ce38adc926ddf62f` (`WORKER_RESEARCH`, 0.0.11337989); the compute worker is listed too.

Each token carries that role's scopes for its KYA level and never `agent:admin`; Claude Code refreshes it on its own (refresh tokens last 8 hours). Picked the wrong row? `/mcp` → the server → **Clear authentication**, then authenticate again.

## 4. Run the flow

```text
/casheth-demo                 # fresh buyer reference PO-CC-<MMDDhhmm>, 1.20 USDC invoice
/casheth-demo PO-CC-7 3.00    # your own reference and amount
```

Or ask for the subagent: "Use the casheth-operator subagent to run the CashETH demo for buyer reference PO-CC-8." The command runs in the main conversation, so you approve each mutating tool call as it comes; the subagent (`.claude/agents/casheth-operator.md`) has only the `casheth-*` tools and Bash, and the same guardrails: never invent ids, one tool call per step, stop on a refusal and report it.

What `/casheth-demo` does (`.claude/commands/casheth-demo.md`):

| # | Server.tool | Result |
|---|---|---|
| 1 | `*.get_agent_stats`, `casheth-wallet.list_accounts` | seller, buyer, worker addresses; the wallet's buyer must be the buyer server's identity |
| 2 | `curl` the paid API `GET /price-feed?symbols=HBAR` | HTTP 402 with the payment requirements (0.50 USDC to 0.0.11333304) |
| 3 | `pnpm -s tsx scripts/make-invoice-fixture.ts --buyer-ref REF --amount A` | a new invoice PDF and the exact upload arguments |
| 4-5 | `casheth-seller.upload_invoice_document`, `upload_receivable` | document anchored on HCS; pending receivable + EIP-712 typed data |
| 6-7 | `casheth-wallet.sign_receivable_confirmation`, `casheth-buyer.confirm_receivable` | `ReceivableRegistry.register`, NFT, credit decision |
| 8-9 | `casheth-seller.get_quotes`, `open_facility` | cheapest-first Aqua fills, `openAndFund` |
| 10 | `casheth-seller.set_budgets` | research worker: alloc 1, maxPerTx 0.5, payee `0x…aceeb8` allowlisted |
| 11-13 | `casheth-worker.reserve_spend`, `pay_x402`, `commit_spend` | 0.50 USDC reserved, paid through x402 (co-signed) and committed; the HBAR price data |
| 14-16 | `casheth-wallet.get_balances`, `casheth-buyer.repay_receivable`, `casheth-wallet.send_calls` | calldata mode; the buyer's exact approval and repayment from the wallet |
| 17-18 | `casheth-buyer.get_receivable_status`, `curl /events` | `Repaid`, debt 0; the audit trail |

Funds it needs: lender liquidity for the borrowing base (`get_quotes` says so; it stops on an empty plan) and buyer USDC at least the invoice amount (`get_balances`; it stops otherwise).

## 5. Evidence

Every tool returns HashScan links (`hashscan`, `payment`, `sent[].hashscan`). The audit trail of the run:

```bash
curl -s http://localhost:4030/events | jq -c '.[-14:] | .[] | {type, id, spendId, hashscan, paymentHashscan, hcsSeq}'
curl -s http://localhost:4030/receivables/<id> | jq '{state, debt, evidence}'
```

`SpendCommitted.paymentHashscan` is the x402 USDC transfer from the research spend wallet (0.0.11339484) to 0.0.11333304; `Repaid` is not recorded by the server when the buyer repays from its own wallet (the repayment is visible in `GET /receivables/:id` as state `Repaid`, debt `0`, and in the wallet's `send_calls` links). Every event is also on the HCS audit topic (`hcsSeq`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| A tool answers `INSUFFICIENT_SCOPE` | that server signed in as another role: Clear authentication in `/mcp` and pick the pre-selected row |
| `repay_receivable` answers `mode: "sent"` | the server holds the buyer key (`AGENT_KEYS_IN_PROCESS=true` or naming `buyer`): restart it with `seller,worker` |
| `pay_x402` answers `KEY_NOT_HELD` | `worker` is missing from `AGENT_KEYS_IN_PROCESS` |
| `pay_x402` answers `MERCHANT_URL_NOT_ALLOWED` | `MERCHANT_ORIGINS` is not set on the MCP server |
| `casheth-wallet` is not connected | `.env` / `.env.accounts` missing, or `pnpm install` not run; `claude mcp get casheth-wallet` shows the error |
| `send_calls` answers `APPROVE_ABOVE_CAP` | the repayment is larger than `WALLET_APPROVE_CAP_USDC` (default 20): raise it in the `casheth-wallet` entry's `env` |

## One-role walkthrough (the `casheth` server)

The original entry still works for a single purchase from the local merchant as the research worker. Start the merchant (`pnpm -F @casheth/merchant start`) and the MCP server with the `worker` role in `AGENT_KEYS_IN_PROCESS`, authenticate `casheth` as the research worker, then:

```text
Use the casheth MCP tools. As the research worker 0xbead36c554746b00eb2a3b87ce38adc926ddf62f, buy one research
report on "Hedera HCS-14" for receivable 0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c:
1. reserve_spend: worker as above, spendWallet 0x0000000000000000000000000000000000ad06dc,
   merchant 0x0000000000000000000000000000000000aceeb8, amount "250000", ttlSeconds 600.
2. pay_x402 with the spendId it returns and url http://localhost:3003/research?topic=Hedera%20HCS-14
3. commit_spend with the same spendId and the transactionId pay_x402 returned.
Then show me the report and the HashScan links.
```

If the worker's budget is used up the reservation is refused with `AGENT_BUDGET_EXCEEDED` (the seller raises it with `set_budgets`). An expired, unpaid reservation is freed with `release_spend`.
