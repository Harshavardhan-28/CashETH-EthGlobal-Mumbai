# CashETH demo: one command, the whole lifecycle

`pnpm demo` runs the full story of BUILD.md section 16 on Hedera testnet. Every action goes through the four agents (`agents/src`), which are MCP clients of the control plane (`apps/mcp-server`); the runner never sends a chain call itself. It prints a HashScan link per step, appends a dated `## Demo run` section to `docs/EVIDENCE.md`, and exits non-zero if any step failed or lacks a Hedera transaction id.

## Run it

```bash
pnpm install
pnpm -r build          # the servers import the workspace packages from dist/
pnpm demo
```

`pnpm demo` starts three child processes, waits for each `/health`, runs the steps, then stops them:

| Server | Package | Default port |
|---|---|---|
| x402 merchant (`/catalog`, `/research`) | `@casheth/merchant` | `MERCHANT_PORT` or 3003 |
| authorization server | `@casheth/auth` | `AUTH_PORT` or 4020 |
| MCP server (tools and read API) | `@casheth/mcp` | `MCP_PORT` or 4030 |

The servers run with `AGENT_KEYS_IN_PROCESS=true` and `LENDER_KEYS_IN_PROCESS=true` (demo only: the server signs as the seller, buyer, workers and lenders with their `.env.accounts` keys). Set `DEMO_SERVERS=external` to use servers you started yourself; then set those two flags (and `MERCHANT_PORT` to the merchant's port) in their environment.

### Environment

`.env` and `.env.accounts` at the repo root, read with `loadEnv()` from `@casheth/shared`: the Hedera network and operator, the merchant account, USDC ids, the x402 facilitator, and the demo accounts (`SELLER`, `BUYER`, `WORKER_RESEARCH`, `WORKER_COMPUTE`, `LENDER_A` to `LENDER_D`, `COORDINATOR`, `COSIGNER`, `KYA_ISSUER`). Also needed: the deployed contracts in `deployments/testnet/addresses.json`, the registered spend wallets in `deployments/testnet/spend-wallets.json`, and the agents registered with `keccak256("mandate-v1-<label>")` mandates (`scripts/c2-register-demo.ts`).

Setup step 0: if `AGENT_NOTES_TOPIC_ID` is not set, the runner creates the agents' HCS notes topic (without a submit key, so every agent account may post) and appends its id to `.env.accounts`; later runs reuse it.

The operator needs enough USDC to top up the two lenders (lenders A and B each need what they ship; the runner sends exactly the shortfall, if any). Faucet: <https://faucet.circle.com> (Hedera Testnet).

The run is repeatable only in part: the server remembers idempotency keys and the receivable `PO-1003` stays registered. A full second run needs a new `INVOICE.buyerRef` in `agents/src/demo/plan.ts`.

All amounts (lender credit, invoice, advance, budgets, spend asks) live in `agents/src/demo/plan.ts`; the expected fills and lender payouts are derived from it with the RepaymentRouter fee formula, so resizing the demo is a one-file change.

## Steps, what each proves, and the track it serves

| # | Step | Proves | Track |
|---|---|---|---|
| 0 | Servers up, agent-notes topic | The control plane is a real service the agents reach over MCP | Hedera Agent Kit |
| 1 | Lenders A (low tier) and B (medium tier) ship fresh credit strategies for the seller (`fund_agents`), after an exact operator top-up if short | Lenders program credit rules into 1inch Aqua strategies on Hedera; capital stays in the lender's wallet | 1inch Aqua |
| 2 | Seller uploads `PO-1003` (30-day term), the buyer signs the EIP-712 confirmation naming the RepaymentRouter as payee, registration on-chain, NFT minted, `ReceivableConfirmed` on HCS; seller agent posts an HCS note | Verified, buyer-signed receivable with an on-chain identity and an audit trail | Hedera Agent Kit, HCS |
| 3 | Same invoice again | `DUPLICATE_RECEIVABLE`, rejected by the server's registry state check (it reads the registered state; no contract call is made); the proof is the rejection recorded on HCS | Hedera |
| 4 | `get_quotes`, then `open_facility` (advance 7500 bps) | The modified SwapVM router fills cheapest first up to the facility's borrowing base (advance 7500 bps; the last lender may fill partially); C skipped by price, D skipped `SELLER_NOT_FUNDED_BY_LENDER`; one transaction funds the facility | 1inch Aqua (headline) |
| 5 | `set_budgets` | Per-worker budgets, per-transaction and daily limits, and a merchant allowlist | x402 / agent spend control |
| 6 | Trader volume on the base-yield strategies | Skipped: the trader agent (Task 4.6) is not in this build | 1inch Aqua |
| 7 | Research worker buys `/research` (0.25 USDC): reserve, x402 payment from the 2-of-2 spend wallet co-signed through x402.org, commit; worker posts an HCS note. Then 0.6 USDC is refused (`TX_LIMIT_EXCEEDED`) and the compute worker's 5.5 USDC is refused (`AGENT_BUDGET_EXCEEDED`) | Agents spend credit only inside the mandate; the co-signer cannot be bypassed; refusals are on HCS | x402, Hedera Agent Kit |
| 8 | Buyer repays the whole invoice | Lenders are paid first (principal plus the 30-day minimum fee, Ruling R29; checked by balance deltas), the seller receives the remainder, state `Repaid`, debt 0, buyer reputation updated | 1inch Aqua, Hedera |
| 9 | Yield table (`GET /lenders`) and agent stats (`GET /agents`) | What lenders earned and the agents' reputation after the run | 1inch Aqua |

## Evidence

Each row of the `## Demo run <ISO date>` table in `docs/EVIDENCE.md` is `step | Hedera transaction id (HashScan link) | result`. EVM transactions are shown as the Hedera transaction they became (resolved through the mirror node). A rejection has no chain transaction of its own, so its proof is the HCS message the control plane published for it. Steps that were skipped or only read are marked as such and are exempt from the transaction rule. Nothing is written when a step fails.

## Tests

`agents/src/demo.test.ts` covers the pure parts (step order, evidence format, exit-code rule, lender top-up arithmetic, quote-plan check, servers and notes topic setup) and runs all the steps against fake agents. Run `pnpm -F @casheth/agents test`.
