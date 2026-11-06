# Claude Code as the live agent

Claude Code connects to the CashETH MCP server as a remote MCP client, signs in through the demo authorization-code grant (PKCE, dynamic client registration) and buys the merchant's `/research` report as the research worker: reserve, pay through x402, commit. No API key is needed in our code: Claude Code is the agent.

The demo grant has no owner login: whoever reaches the consent page can act as any demo agent. It is off unless `AUTH_DEMO_GRANT=true`, and both servers listen on `127.0.0.1` only. Never enable it on a public host.

## 1. Start the servers

From the repo root, with `.env` and `.env.accounts` in place, one terminal each:

```bash
pnpm -F @casheth/merchant start                              # :3003
AUTH_DEMO_GRANT=true pnpm -F @casheth/auth start             # :4020
AGENT_KEYS_IN_PROCESS=true pnpm -F @casheth/mcp start        # :4030
```

`AGENT_KEYS_IN_PROCESS=true` lets the MCP server sign the worker's half of the 2-of-2 spend wallet; the co-signer still checks every payment against the reservation.

## 2. Add the server to Claude Code

The repo's `.mcp.json` already declares `casheth` (`http://localhost:4030/mcp`); Claude Code asks to approve it when started in this directory. Or add it yourself:

```bash
claude mcp add --transport http casheth http://localhost:4030/mcp
```

## 3. Sign in as the research worker

In Claude Code run `/mcp`, choose `casheth`, then **Authenticate**. The browser opens the CashETH consent page. Click **Act as worker** on the row for `0xbead36c554746b00eb2a3b87ce38adc926ddf62f` (the research worker, `WORKER_RESEARCH`, account 0.0.11337989). The token carries the worker scopes (`spend:reserve spend:pay spend:commit` plus the read scopes), never `agent:admin`; Claude Code refreshes it on its own.

## 4. Prompt

```text
Use the casheth MCP tools. As the research worker 0xbead36c554746b00eb2a3b87ce38adc926ddf62f, buy one research
report on "Hedera HCS-14" for receivable 0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c:
1. reserve_spend: worker as above, spendWallet 0x0000000000000000000000000000000000ad06dc,
   merchant 0x0000000000000000000000000000000000aceeb8, amount "250000", ttlSeconds 600.
2. pay_x402 with the spendId it returns and url http://localhost:3003/research?topic=Hedera%20HCS-14
3. commit_spend with the same spendId and the transactionId pay_x402 returned.
Then show me the report and the HashScan links.
```

Each step is one tool call with an `idempotencyKey` Claude Code chooses. `pay_x402` pays at most once per reservation: a retry returns the first settlement. If the worker's budget is used up the reservation is refused with `AGENT_BUDGET_EXCEEDED` (the seller raises it with `set_budgets`). An expired, unpaid reservation is freed with `release_spend`.

## 5. Evidence

```bash
curl -s http://localhost:4030/events | jq '.[-3:] | .[] | {type, spendId, hashscan, paymentHashscan, hcsSeq}'
```

`SpendReserved` and `SpendCommitted` link the `CreditFacility.reserve` / `commit` transactions; `paymentHashscan` on `SpendCommitted` is the x402 USDC transfer from spend wallet 0.0.11339484 to the merchant 0.0.11333304. Every event is also on the HCS audit topic (`hcsSeq`).
