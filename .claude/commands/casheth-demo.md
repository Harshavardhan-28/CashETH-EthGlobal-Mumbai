---
description: Run the CashETH end-to-end demo on Hedera testnet - new invoice, buyer signature from the local wallet, financing, a 0.50 USDC x402 purchase from the paid API, non-custodial repayment - and print every HashScan link.
argument-hint: "[buyerRef] [amount USDC, default 1.20]"
allowed-tools: Bash(curl:*), Bash(date:*), Bash(jq:*), Bash(pnpm -s tsx scripts/make-invoice-fixture.ts:*), mcp__casheth-seller__get_agent_stats, mcp__casheth-buyer__get_agent_stats, mcp__casheth-worker__get_agent_stats, mcp__casheth-seller__get_quotes, mcp__casheth-seller__get_receivable_status, mcp__casheth-buyer__get_receivable_status, mcp__casheth-wallet__list_accounts, mcp__casheth-wallet__get_balances
---

Run the CashETH end-to-end flow on Hedera testnet. Act as the `casheth-operator` subagent describes (its phases and guardrails apply here too): one tool call per step, read each result before the next, never invent an id, address, amount, hash or signature, pass tool results through unchanged, and stop at the first refusal or error and report it verbatim.

Arguments: `$ARGUMENTS`. The first is the buyer reference (if missing, use the output of `date -u +PO-CC-%m%d%H%M`); the second is the invoice amount in USDC (default `1.20`, sized to the current lender liquidity). Call the reference REF below. Every mutating call's `idempotencyKey` is `cc-REF-<step>` with the step name shown in brackets.

Fixed inputs of this demo (from `docs/API.md` section 6):
- Paid API: `https://casheth-paid-apis-177290233934.asia-southeast1.run.app/price-feed?symbols=HBAR` (0.50 USDC = `500000` units), payee Hedera account `0.0.11333304`, whose long-zero EVM address is `0x0000000000000000000000000000000000aceeb8`.
- Research worker spend wallet: the entry of `deployments/testnet/spend-wallets.json` whose `worker.name` is `WORKER_RESEARCH` (read it with Bash; use its `evmAddress`).

Steps:

1. Identities. `get_agent_stats` (no arguments) on `casheth-seller`, `casheth-buyer` and `casheth-worker`: note each `address`. `casheth-wallet.list_accounts`: the `buyer` account's address must equal the buyer server's address; if not, stop.
2. The paid API without payment: `curl -s -i "<paid API URL>"`. Show the HTTP status (402) and the payment requirements (payee, amount, asset).
3. Invoice: `pnpm -s tsx scripts/make-invoice-fixture.ts --buyer-ref REF --amount <amount>`. It prints JSON with `uploadInvoiceDocument` and `uploadReceivable`.
4. `casheth-seller.upload_invoice_document` with the `uploadInvoiceDocument` object exactly as printed [upload-doc]. `verification.ok` must be true. Note `keccak256`.
5. `casheth-seller.upload_receivable` with `buyer` = the buyer address, `amount`, `dueDate` and `buyerRef` from `uploadReceivable`, and `documentKeccak` = the `keccak256` from step 4 [upload].
6. `casheth-wallet.sign_receivable_confirmation` with `account: "buyer"` and `upload` = the whole step 5 result unchanged.
7. `casheth-buyer.confirm_receivable` with the `pendingId` and `signature` from step 6 [confirm]. Note the receivable `id`, the decision and the HashScan link.
8. `casheth-seller.get_quotes` with the `id`. If `plan.total` is `"0"` or there are no fills, stop: there is no lender liquidity.
9. `casheth-seller.open_facility` with the `id` [open]. Note `funded`.
10. `casheth-seller.set_budgets` with the `id` and one budget for the research worker: `worker` = the worker address, `alloc` `"1000000"`, `maxPerTx` `"500000"`, `maxDaily` `"2000000"`, `merchants` `["0x0000000000000000000000000000000000aceeb8"]` [budgets]. If `alloc` is above `funded`, use `funded` as `alloc` instead.
11. `casheth-worker.reserve_spend` with the `id`, `worker` = the worker address, `spendWallet` = the research spend wallet, `merchant` `0x0000000000000000000000000000000000aceeb8`, `amount` `"500000"`, `ttlSeconds` `600` [reserve]. Note `spendId`.
12. `casheth-worker.pay_x402` with the `spendId` and the paid API URL [pay]. Show the `body` (the HBAR price data) and note `transactionId`.
13. `casheth-worker.commit_spend` with the `spendId` and `hederaTxId` = the `transactionId` from step 12 [commit].
14. `casheth-wallet.get_balances` for `buyer`: its `usdc` must be at least the invoice amount in units; if not, stop and say so.
15. `casheth-buyer.repay_receivable` with the `id` and `amount` = the invoice amount in units [repay]. It must answer `mode: "calldata"` with two calls (exact `approve`, then `repay`); if it answers `mode: "sent"`, the server holds the buyer key: report that and do not send anything.
16. `casheth-wallet.send_calls` with `account: "buyer"` and `calls` = the `calls` array from step 15 unchanged.
17. `casheth-buyer.get_receivable_status` with the `id`. Expect `state: "Repaid"` and `debt: "0"` (`send_calls` returns only after the repayment is mined); report any other state as it is.
18. Evidence: `curl -s http://localhost:4030/events | jq -c '[.[] | select(.id == "<id>" or .spendId == "<spendId>") | {type, hashscan, paymentHashscan, hcsSeq}]'`.

Finish with a table: step, tool, outcome, HashScan link (every link from steps 4-16 and the events), then the final receivable state.
