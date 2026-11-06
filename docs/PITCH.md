# CashETH pitch (8 slides, about 3 minutes)

Slide-by-slide outline with what to say. The live demo segment follows [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Figures are linked to their sources; business detail is in [BUSINESS.md](BUSINESS.md) and network numbers in [NETWORK_IMPACT.md](NETWORK_IMPACT.md).

## 1. Title

**CashETH: invoices your agents can spend.** Autonomous working capital for AI agents, on Hedera.

## 2. The problem

Selling on credit means waiting to be paid. Invoice finance moved **€4,039 billion** in 2025 ([FCI](https://fci.nl/en/news/fci-releases-2025-world-industry-statistics-global-factoring-market-surpasses-eu4-trillion)) and still leaves a **US$5.7 trillion** MSME finance gap in emerging markets ([IFC / SME Finance Forum](https://www.smefinanceforum.org/news/11526737)), about **Rs 30 lakh crore** of it in India ([SIDBI, via The Tribune](https://www.tribuneindia.com/news/business/indias-msmes-face-credit-gap-of-rs-30-lakh-crore-women-owned-businesses-see-highest-shortfall-report)). In the US, **22% of B2B receivables** are paid late ([Atradius 2026](https://group.atradius.com/knowledge-and-research/reports/b2b-payment-practices-trends-in-the-us-2026)).

Say: AI agents now sell to each other and pay per request over x402. An agent that has invoiced but not been paid has the same cash gap, and no bank will lend to it.

## 3. The solution

A seller agent turns an invoice **its customer has signed** into USDC credit. Its worker agents spend that credit on paid APIs through x402, inside budgets the contract enforces. When the customer pays, lenders are repaid first, automatically.

## 4. How it works (eight steps, one network)

Upload → buyer signs (EIP-712) → verify (KYA, dedupe, score) → register (NFT + HCS) → lenders ship Aqua strategies → fund in one transaction through the modified SwapVM → workers spend over x402 from 2-of-2 wallets → repay, lenders first.

Show the architecture diagram (`diagrams/architecture-hedera.png`).

## 5. Live demo

Claude Code as the seller agent (`/casheth-demo`): hit a paid API and get a 402, raise credit against a new invoice, buy the data over x402 with that credit, settle the loan. Every step prints a HashScan link.

## 6. Why Hedera, and what is new

- **HTS** USDC and a receivable NFT; **HCS** audit trail and HCS-14 agent identities; **HSS** schedules created by the facility contract for the overdue and default lifecycle; **threshold keys** for co-signed spend wallets; **x402** settled on `hedera:testnet`.
- **New:** a custom SwapVM opcode checks the receivable's on-chain state inside every Aqua fill, so lender capital can only move against a confirmed, unfinanced invoice.
- Each receivable is 13 Hedera transactions plus 5 per paid request ([NETWORK_IMPACT.md](NETWORK_IMPACT.md)).

## 7. Business and go-to-market

Proposed revenue: a 0.5% origination fee and a 10% share of lender fees. Start with agent developers through MCP and Claude Code, then x402 merchants, then Aqua lenders, then India MSMEs through GST e-invoice evidence.

## 8. Where we are and the ask

Working end to end on Hedera testnet, with 181 Foundry tests, the TypeScript suites, CI and a HashScan-verified evidence index. Next: pull-based repayment and KMS keys, then a capped pilot with 3 to 5 agent teams.

**Ask:** try it and tell us what breaks ([feedback form](https://github.com/Harshavardhan-28/CashETH-EthGlobal-Mumbai/issues/new?template=feedback.yml)), and introduce us to agent teams and lenders who want to pilot.
