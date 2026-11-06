# Business model, go-to-market and roadmap

## The problem

Businesses that sell on credit wait for their money. Invoice finance exists for exactly this, and it is large: global factoring turnover was **€4,039 billion in 2025** ([FCI, 5 May 2026](https://fci.nl/en/news/fci-releases-2025-world-industry-statistics-global-factoring-market-surpasses-eu4-trillion)). It still leaves most small firms out. The formal MSME finance gap in emerging markets is **US$5.7 trillion** ([IFC / SME Finance Forum](https://www.smefinanceforum.org/news/11526737), 2019 data), and in India alone SIDBI estimates an addressable MSME credit gap of **about Rs 30 lakh crore, roughly 24% of credit demand** ([reported by The Tribune, May 2025](https://www.tribuneindia.com/news/business/indias-msmes-face-credit-gap-of-rs-30-lakh-crore-women-owned-businesses-see-highest-shortfall-report)). Late payment makes the wait worse: in the US, **22% of B2B receivables** are paid late ([Atradius Payment Practices Barometer, US 2026](https://group.atradius.com/knowledge-and-research/reports/b2b-payment-practices-trends-in-the-us-2026)).

AI agents now sell services to each other and pay per request over x402, which "has processed millions of transactions" ([x402.org](https://www.x402.org/)). An agent that has earned revenue but not yet been paid has the same cash gap as a small business, and no bank will underwrite it. CashETH lets that agent borrow against the invoice its customer has signed, and spend the advance only on what its owner allows.

## Lean canvas

| Block | CashETH |
| --- | --- |
| **Problem** | 1. Agents that sell on terms wait for payment and cannot buy the inputs (APIs, compute, data) they need meanwhile. 2. Lenders cannot see or trust an agent's receivables. 3. Owners cannot let an agent hold credit without hard spending limits. |
| **Customer segments** | Early adopters: developers running agent services with recurring business customers (research, data, compute resellers). Lenders: holders of idle USDC who want short-dated, receivable-backed yield. Merchants: x402 API sellers who gain buyers that can pay. |
| **Unique value proposition** | Working capital against an invoice the buyer signed, funded in one Hedera transaction by the cheapest willing lender, and spendable only inside per-agent budgets that the contract re-checks. |
| **Solution** | Buyer-signed EIP-712 receivables, a receivable registry with an NFT and an HCS audit trail, Aqua strategies gated by an on-chain receivable check, 2-of-2 co-signed spend wallets, and a lenders-first repayment router. |
| **Channels** | An MCP server and Claude Code skill (`/casheth-demo`), x402 merchant directories, the 1inch Aqua strategy ecosystem, and Hedera developer programs. |
| **Revenue streams** | Proposed: an origination fee on each advance and a share of the lender fee at repayment (see below). |
| **Cost structure** | Hedera network fees, the facilitator and relay infrastructure, the co-signer and coordinator service, and identity (KYA) checks. |
| **Key metrics** | Receivables financed, USDC advanced, repayment rate (on time, late, default), x402 requests paid with credit, active agent accounts. |
| **Unfair advantage** | The receivable check runs inside the SwapVM fill itself, so lender capital can only move against a confirmed, unfinanced receivable. That, plus the HCS audit trail, makes the underwriting inspectable by anyone. |

## Revenue model (proposed, to be validated)

| Stream | Proposal | Paid by |
| --- | --- | --- |
| Origination fee | 0.5% of each advance, taken at `openAndFund` | Seller agent |
| Protocol share of lender fee | 10% of the fee lenders earn, taken by `RepaymentRouter` at repayment | Lenders |

On the testnet demo's 4.5 USDC advance at a blended 7.3% APR for 30 days, that is about 0.02 USDC of origination fee plus a fraction of a cent of fee share. Revenue only becomes meaningful at volume, which is why the go-to-market below targets agent platforms with many sellers rather than single sellers. Neither fee is implemented in the contracts yet.

Hedera keeps the per-receivable cost low. At the published base fees ($0.0008 per HCS message, $0.001 per token transfer, $0.02 per NFT mint; [Hedera fee schedule](https://docs.hedera.com/hedera/networks/mainnet/fees)), the 7 HCS messages and 1 NFT mint of a receivable cost about $0.026, plus contract gas. Each paid request adds about $0.0026 (2 HCS messages and 1 token transfer), plus gas. The counts are in [NETWORK_IMPACT.md](NETWORK_IMPACT.md).

## Why this needs a public ledger

A Web2 lender could advance cash against an invoice. It could not offer what CashETH does:

- **Lenders keep custody.** USDC stays in each lender's own wallet until a fill. A Web2 lender pools funds with an intermediary.
- **The credit check is enforced, not promised.** The `ReceivableCredit` opcode reads the receivable's state on-chain during the fill, so an unconfirmed or already financed invoice cannot be funded by anyone, including us.
- **Repayment order is code.** `RepaymentRouter` is the payee in the buyer's own signature and pays lenders first. No servicer can redirect it.
- **Agents pay agents.** Workers spend through x402 in USDC with no accounts or API keys, which card rails do not support for machine-to-machine micropayments.
- **Anyone can audit it.** Every decision and payment is an HCS message and a mirror-node record.

Hedera specifically gives fixed USD fees, fast finality for per-request payments, native USDC, scheduled transactions for the overdue and default lifecycle, and threshold keys for co-signed spend wallets, all on one network.

## Go-to-market

1. **Agent developers first.** Ship the seller as an MCP server and Claude Code skill (already working), and list it where agent builders look for tools. Target: 10 developer teams running the testnet flow.
2. **x402 merchants second.** Partner with x402 API sellers, starting with our own `casheth-paid-apis`. A merchant gains customers that can pay before they have been paid themselves.
3. **Lenders from the Aqua ecosystem.** Aqua lenders already ship strategies. A credit strategy is one more, backed by the same balance, with the risk tier chosen by the lender.
4. **India MSMEs later.** Accept GST e-invoice data as extra evidence on a receivable (roadmap), which links the agent flow to the Rs 30 lakh crore MSME gap.

## Roadmap

| Phase | Timing | Scope |
| --- | --- | --- |
| Hackathon | Done | Full lifecycle on Hedera testnet, modified SwapVM, x402 spend, HCS audit, HSS schedules, Claude Code seller. |
| Hardening | Next 4 to 6 weeks | Pull-based repayment (fixes the griefing limit), undrawn funds returned on default, spend wallet bound on-chain, KMS-held coordinator and co-signer keys, independent contract review. |
| Pilot | Following 2 to 3 months | 3 to 5 agent teams and a small lender group on testnet, then a capped mainnet pilot. Implement the origination fee and fee share. |
| Scale | After the pilot | Real identity and owner-separation proofs instead of the KYA allowlist, cross-registry repayment reputation, GST e-invoice evidence. |

## Market feedback cycles

1. **Developer trials.** Each trial runs the Claude Code flow and answers the feedback form. We change the tool surface based on where people get stuck. Results go in [FEEDBACK.md](FEEDBACK.md).
2. **Lender interviews.** Ask DeFi lenders what APR, advance rate and tenor they would accept for a given buyer reputation, and tune the strategy tiers.
3. **Merchant pilots.** Track how many x402 requests are paid with credit and whether merchants see new buyers.
4. **Repayment data.** On-time, late and default counts accrue in `KYARegistry` and feed the credit score directly.
