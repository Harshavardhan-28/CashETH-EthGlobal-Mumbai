# Network impact

What CashETH puts on Hedera, counted from the code paths in `apps/mcp-server/src/orchestrator/` and the transactions recorded in [EVIDENCE.md](EVIDENCE.md). Every audit event is also an HCS message (`orchestrator/audit.ts`), so each step below costs at least one consensus transaction.

## Transactions per receivable

| Step | Hedera transactions | Services | Recorded example |
| --- | --- | --- | --- |
| Invoice document hashes anchored | 1 | HCS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.11333252@1793989232.828981158) |
| `ReceivableUploaded` | 1 | HCS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.11333252@1793989247.470231008) |
| `ReceivableRegistry.register` (buyer's EIP-712 confirmation) | 1 | Smart contract | [PO-1003](https://hashscan.io/testnet/transaction/0.0.7314364@1793989261.174955397) |
| `ReceivableConfirmed` | 1 | HCS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.11333252@1793989268.825602126) |
| Receivable NFT minted | 1 | HTS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.11333252@1793989271.529110857) |
| `NftMinted` | 1 | HCS | [PO-1002](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.577011440) |
| `CreditFacility.openAndFund` through the modified SwapVM router | 1, plus child records: one HTS USDC transfer per filled lender and one `ScheduleCreate` (`markOverdue`) | Smart contract, HTS, HSS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.7314364@1793991157.490753368) |
| `FacilityFunded` | 1 | HCS | [PO-1002](https://hashscan.io/testnet/transaction/0.0.11333252@1793982667.668877640) |
| Worker budgets set, plus `BudgetsSet` | 2 | Smart contract, HCS | [PO-1003](https://hashscan.io/testnet/transaction/0.0.7314364@1793991182.937546658) |
| Repayment: USDC approve, `RepaymentRouter.repay`, plus `Repaid` | 3, plus child records: one HTS transfer per lender and one to the seller | Smart contract, HTS, HCS | Code path `orchestrator/repay.ts`; not yet recorded on the current stack |
| **Fixed per receivable** | **13** | | |

Each paid request a worker makes with that credit adds five more:

| Step | Hedera transactions | Services | Recorded example |
| --- | --- | --- | --- |
| `CreditFacility.reserve` (facility funds the spend wallet), plus `SpendReserved` | 2 | Smart contract, HTS, HCS | [reserve](https://hashscan.io/testnet/transaction/0.0.7314364@1793985356.566369946) |
| x402 settlement from the 2-of-2 spend wallet to the merchant | 1 | HTS, threshold key, x402 facilitator | [settlement](https://hashscan.io/testnet/transaction/0.0.9185802@1793985365.210563681) |
| `CreditFacility.commit`, plus `SpendCommitted` | 2 | Smart contract, HCS | [commit](https://hashscan.io/testnet/transaction/0.0.7314364@1793985376.841020355) |
| **Per paid request** | **5** | | |

So one receivable that finances `P` paid requests produces **13 + 5P** Hedera transactions, before child records. Rejected requests add an HCS `SpendRejected` each, and a late receivable adds the executed `markOverdue` schedule and its follow-up.

## Accounts per participant

| Participant | New Hedera accounts | Why |
| --- | --- | --- |
| Seller agent | 1 | Holds the advance and the receivable's surplus at repayment |
| Each worker agent | 2 | The worker's own account plus its 2-of-2 spend wallet (worker key + policy co-signer) |
| Buyer agent | 1, if new | Signs the confirmation and repays from its own account |
| Each lender | 1 | Ships Aqua strategies from its own wallet; USDC never leaves it until a fill |

Platform accounts (coordinator, co-signer, KYA issuer) are created once. The testnet demo created 10 agent accounts (1 seller, 1 buyer, 2 workers with 2 spend wallets, 4 lenders), each with an HCS-14 profile on the audit topic.

## Illustrative scale

These numbers are an assumption-driven example, not traction. Take 100 seller agents, each running 2 workers, each financing 4 receivables a month, each receivable paying for 50 x402 requests:

| Quantity | Calculation | Result |
| --- | --- | --- |
| Agent accounts | 100 × (1 seller + 2 × 2 worker accounts) | 500, plus buyers and lenders |
| Receivables per month | 100 × 4 | 400 |
| Transactions per month | 400 × (13 + 5 × 50) | 105,200 |
| Average load | 105,200 / 2,592,000 s | about 0.04 TPS |

Almost all of the volume (100,000 of 105,200) comes from the per-request x402 payments and their reservations, so transaction count grows with how much the agents buy, not with how many invoices they raise. About 40% of all transactions are HCS audit messages, which is what makes every credit decision and payment independently checkable on the mirror node.

## Who it brings to Hedera

- **AI-agent developers.** The seller runs from Claude Code over MCP (`/casheth-demo`), and every agent gets a Hedera account and an HCS-14 identity.
- **API sellers.** x402 merchants are paid in HTS USDC on `hedera:testnet` with no accounts or API keys on the buyer side; `casheth-paid-apis/` is a live example.
- **DeFi liquidity.** 1inch Aqua lenders put idle USDC to work on Hedera, with one balance backing a base-yield and a credit strategy.
