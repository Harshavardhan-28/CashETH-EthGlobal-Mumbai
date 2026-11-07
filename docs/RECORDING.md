# Recording the Atlas demo

Atlas (`.claude/commands/atlas.md`) is an autonomous research agent with a reason to borrow: a client wants an HBAR
market brief today, the data costs 0.50 USDC over x402, and Atlas's only asset is an unpaid 1.20 USDC invoice. It
borrows against the invoice, buys the data, writes the brief and settles the loan, with no input after you type
`/atlas`. A take runs about 3 to 5 minutes on testnet.

## Before you press record (off camera)

1. Start the servers and wait for the ready line:
   ```bash
   pnpm servers
   # wait for: [mcp] read API ready
   ```
2. Start the dashboard (`cd frontend && pnpm dev`) and open http://localhost:3000/dashboard, choose **seller-co**,
   **Invoices**. Put it next to the terminal.
3. Open Claude Code in this repo and sign in once with `/mcp` (casheth-seller, approve the seller). Run `/clear` so
   the take starts on an empty screen.
4. Optional: open https://hashscan.io/testnet in a third tab to click a link live.

## The take

1. Start recording.
2. Type `/atlas` and press Enter. For a different invoice size: `/atlas 2.00` (lender liquidity allows a few USDC).
3. Hands off. Atlas prints one `▶ Scene` heading per step:

| Scene | What the viewer sees |
| --- | --- |
| 1 · The job | The paid API answers 402: 0.50 USDC, and Atlas has no cash |
| 2 · The asset | A fresh invoice PDF, uploaded and checked against its hash |
| 3 · The customer confirms | buyer-co signs the invoice; it becomes an on-chain receivable and an NFT |
| 4 · Your price | Credit score, risk slab and rate, priced on chain from Atlas's own record |
| 5 · Borrow | Lenders' Aqua strategies fund the advance at that rate; others are skipped with a reason |
| 6 · Budget | The worker gets an on-chain budget and a one-merchant allowlist |
| 7 · Buy the data | The worker pays over x402 from its 2-of-2 spend wallet; the prices arrive |
| 8 · Deliver the job | Atlas writes the client's HBAR brief from the data it bought |
| 9 · Your client pays | buyer-co pays; lenders are paid principal plus interest first, the receivable is Repaid |
| Finale | Every HashScan link and a three-line story |

4. Cut to the dashboard: the new invoice row, **N proof links** (every link of the run), the activity log and the
   seller's rate tile. Each successful run raises Atlas's score by 15 points, so the next take prices a little lower.

## If a take goes wrong

- Atlas stops and quotes the error. Fix the cause (usually a server that was not ready) and run `/atlas` again: each
  take uses a new invoice reference, so takes never collide.
- "no lender liquidity": the lenders' strategies are used up; run a smaller amount (`/atlas 1.00`).
- Hashio, the public relay, can take 10 to 30 s on a transaction. That is normal; trim it in the edit.
