---
description: Run the CashETH end-to-end demo on Hedera testnet as the seller agent - hit a paid API and get a 402, raise credit against a new invoice, buy the data over x402 with that credit, then settle the loan - and print every HashScan link.
argument-hint: "[buyerRef] [amount USDC, default 1.20]"
allowed-tools: Bash(curl:*), Bash(date:*), Bash(jq:*), Bash(grep:*), Bash(pnpm -s tsx scripts/make-invoice-fixture.ts:*), mcp__casheth-seller__whoami, mcp__casheth-seller__get_receivable_status
---

Run the CashETH end-to-end flow on Hedera testnet as the seller agent. You are the main agent: you need data from a paid API, have no cash, and raise working capital against an invoice your customer owes you. The buyer (your customer) and your worker are counterparties the CashETH server runs with their own keys; you drive them through your seller tools. Act as the `casheth-operator` subagent describes: one tool call per step, read each result before the next, never invent an id, address, amount, hash or signature, pass tool results through unchanged, and stop at the first refusal or error and report it verbatim.

Before step 1: if `casheth-seller` is not connected, stop and tell the user to run `pnpm -r build`, start the auth and MCP servers as in docs/CLAUDE_CODE_DEMO.md section 1, and sign in with `/mcp`.

Arguments: `$ARGUMENTS`. The first is the buyer reference (if missing, use the output of `date -u +PO-CC-%m%d%H%M`); the second is the invoice amount in USDC (default `1.20`, sized to the current lender liquidity). Call the reference REF below. Every mutating call's `idempotencyKey` is `cc-REF-<step>` with the step name shown in brackets.

Fixed inputs:
- Paid API: `https://casheth-paid-apis-177290233934.asia-southeast1.run.app/price-feed?symbols=HBAR` (0.50 USDC = `500000` units), payee Hedera account `0.0.11333304` (long-zero EVM `0x0000000000000000000000000000000000aceeb8`).
- Your customer (the buyer): `grep -E '^BUYER_EVM=' .env.accounts | cut -d= -f2`. Your worker: `grep -E '^WORKER_RESEARCH_EVM=' .env.accounts | cut -d= -f2`. These are public addresses; never read any other line of that file.

Steps:

1. `casheth-seller.whoami`: note your `address`; `role` must be `seller`.
2. The paid API without payment: `curl -s -i "<paid API URL>"`. Show the HTTP status (402) and the payment requirements (payee, amount, asset). You cannot pay: you have no working capital yet.
3. Invoice: `pnpm -s tsx scripts/make-invoice-fixture.ts --buyer-ref REF --amount <amount>`. It prints JSON with `uploadInvoiceDocument` and `uploadReceivable`.
4. `upload_invoice_document` with the `uploadInvoiceDocument` object exactly as printed [upload-doc]. `verification.ok` must be true. Note `keccak256`.
5. `upload_receivable` with `buyer` = the buyer address, `amount`, `dueDate` and `buyerRef` from `uploadReceivable`, and `documentKeccak` = the `keccak256` from step 4 [upload]. Note `pendingId`.
6. `request_buyer_confirmation` with the `pendingId` [confirm]. The buyer signs the EIP-712 confirmation with its own key and the receivable is registered. Note the receivable `id`, the credit decision and the HashScan link.
7. `open_facility` with the `id` [open]. There is no negotiation: the credit comes from shared liquidity, and the server fills the cheapest eligible lender strategies itself, in one transaction. Report `funded`, which lenders filled and which were skipped and why (`plan.skipped`), and the HashScan link. If it is refused because no lender can fill, stop: there is no lender liquidity. (`get_quotes` previews the same plan without funding; you do not need it.)
8. `set_budgets` with the `id` and one budget for your worker: `worker` = the worker address, `alloc` `"1000000"`, `maxPerTx` `"500000"`, `maxDaily` `"2000000"`, `merchants` `["0x0000000000000000000000000000000000aceeb8"]` [budgets]. If `alloc` is above `funded`, use `funded` as `alloc` instead.
9. `buy_with_credit` with the `id`, `url` = the paid API URL, `merchant` `0.0.11333304`, `amount` `"500000"` [buy]. Your worker reserves the credit, pays the x402 merchant through its 2-of-2 spend wallet (the co-signer checks the payment) and commits. Show the price data and note `transactionId`.
10. `settle_receivable` with the `id` [settle]. Your customer pays the invoice: lenders get principal plus fee first, you get the rest. Note the split and the HashScan link.
11. `get_receivable_status` with the `id`. Expect `state: "Repaid"`; report any other state as it is.
12. Evidence: `curl -s http://localhost:4030/events | jq -c '[.[] | select(.id == "<id>") | {type, hashscan, paymentHashscan, hcsSeq}]'`.

Finish with a table: step, tool, outcome, HashScan link (every link from steps 4-10 and the events), then a two-line story: what you borrowed against, what you bought with it, and how the loan was settled.
