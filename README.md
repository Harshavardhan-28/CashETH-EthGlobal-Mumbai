# CashETH

**Autonomous working capital for agents, on Hedera testnet.** A seller agent turns a buyer-signed receivable into USDC credit that its worker agents spend through x402. When the buyer pays, lenders are repaid first, on-chain.

Built for ETHGlobal Mumbai. Targets: Hedera "AI Agents That Pay (x402)" and 1inch "Build an Aqua App".

Powered by Aqua — © Degensoft Ltd 2025

> Status: first documentation pass. Everything with an on-chain link has been executed on Hedera testnet (chain 296) and is recorded in [docs/EVIDENCE.md](docs/EVIDENCE.md). Items still being built are marked `TODO(8.2-final)` and listed in the open-items table at the end.

## Contents

1. [What it is](#what-it-is)
2. [Architecture](#architecture)
3. [Deployed contracts and accounts](#deployed-contracts-and-accounts)
4. [Payment flow](#payment-flow)
5. [Modified SwapVM and Aqua](#modified-swapvm-and-aqua)
6. [Shared liquidity: base yield, credit boost, risk tiers](#shared-liquidity-base-yield-credit-boost-risk-tiers)
7. [x402 spending](#x402-spending)
8. [Settled transactions](#settled-transactions)
9. [Prize-track checklists](#prize-track-checklists)
10. [How to run](#how-to-run)
11. [Frontend and read API](#frontend-and-read-api)
12. [Attribution and licenses](#attribution-and-licenses)
13. [Rulings and known limitations](#rulings-and-known-limitations)
14. [Next steps](#next-steps)
15. [Open items for the final pass](#open-items-for-the-final-pass)

Demo script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md). Full evidence log: [docs/EVIDENCE.md](docs/EVIDENCE.md).

## What it is

Agents pay for things now. Buyers pay them in 30 to 60 days. CashETH closes that gap:

1. The seller agent uploads a receivable. The buyer agent signs an EIP-712 `ReceivableConfirmation` naming our `RepaymentRouter` as payee. That signature is the root of trust.
2. `ReceivableRegistry.register` verifies it on-chain (signature, KYA levels, owner separation, term, duplicate check) and the receivable becomes `Confirmed`. An HTS NFT and an HCS audit message are the handle and the log.
3. Lenders have shipped Aqua strategies from their own wallets. The credit facility fills the eligible ones through our modified SwapVM router. The router's new opcode checks the on-chain receivable state on every fill, and the facility marks the receivable `Financed` in the same transaction.
4. Worker agents reserve spend, pay merchants through x402 from 2-of-2 co-signed spend wallets, and commit the spend.
5. The buyer repays through `RepaymentRouter`. Lenders get principal plus fee first, the seller agent gets the rest.

The repayment fee is `principal * apr * max(elapsed, minTerm) / 365 days`.

## Architecture

![CashETH architecture](diagrams/architecture-hedera.png)

| Layer | Component | Role |
| --- | --- | --- |
| Agents | seller, buyer, worker, lender, trader | MCP clients. Each has an ECDSA key, a Hedera account, an HCS-14 UAID and a KYA level. |
| Access | `apps/mcp-server`, `apps/auth-server` | MCP tools behind OAuth 2.1; KYA checked at the authorization server |
| Brain | `packages/engine` | Credit score, borrowing base, spend policy, co-signer policy, event store |
| Hedera EVM | `KYARegistry`, `ReceivableRegistry`, `CreditFacility`, `ReceivableCreditNote`, `RepaymentRouter` | Identity, receivable state machine, funding and budgets, repayment waterfall |
| Hedera EVM | Aqua registry, `CashEthSwapVMRouter`, `CashEthOrderBuilder`, `CashEthTaker` | Shared-liquidity strategies and the credit opcode |
| Hedera native | HTS, HCS, HSS | USDC and the receivable NFT, the audit topic and HCS-14 profiles, scheduled overdue/default checks |
| Merchant | `apps/merchant` | Our x402-protected research API |

Everything runs on one chain, so register, fund, reserve and repay need no cross-chain attestation. The off-chain trust that remains is the coordinator (it submits `openAndFund` and `reserve`; the contracts re-check every limit) and the policy co-signer on spend wallets (it can refuse a payment but cannot move funds alone).

## Deployed contracts and accounts

Network: Hedera testnet, EVM chain 296. USDC is HTS `0.0.429274` with EVM facade `0x0000000000000000000000000000000000068cDa`, 6 decimals. Machine-readable addresses: [deployments/testnet/addresses.json](deployments/testnet/addresses.json). Deploy transactions, gas and read-backs: [docs/EVIDENCE.md](docs/EVIDENCE.md) sections C2 to C4.

| Contract | EVM address | HashScan | Deploy tx |
| --- | --- | --- | --- |
| KYARegistry | `0xE51950be227c5A31B603e1343cD53e813C593f39` | [0.0.11338820](https://hashscan.io/testnet/contract/0.0.11338820) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966394.171576721) |
| ReceivableRegistry | `0x112167Ad230f4b733B756201FDe8b4ec3BC97A8b` | [0.0.11338823](https://hashscan.io/testnet/contract/0.0.11338823) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966402.245288564) |
| ReceivableCreditNote (RCN) | `0x54a665d52E2e79bA3Ec46b20f8c2cfE950C9A0ce` | [0.0.11339718](https://hashscan.io/testnet/contract/0.0.11339718) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793971488.122320980) |
| CreditFacility | `0xfe702433E753ca4CA8dEDC3059987eCA7B8fe640` | [0.0.11339720](https://hashscan.io/testnet/contract/0.0.11339720) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793971495.452167794) |
| RepaymentRouter | `0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7` | [0.0.11339725](https://hashscan.io/testnet/contract/0.0.11339725) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793971507.280224870) |
| Aqua registry (`AquaRouter`, redeployed by us, block 42741303) | `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c` | [0.0.11339989](https://hashscan.io/testnet/contract/0.0.11339989) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973211.309180764) |
| CashEthSwapVMRouter (modified SwapVM) | `0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562` | [0.0.11339992](https://hashscan.io/testnet/contract/0.0.11339992) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973238.198619187) |
| CashEthOrderBuilder | `0x4125108453A1E9c333b100a917F630b84F3413Fb` | [0.0.11339998](https://hashscan.io/testnet/contract/0.0.11339998) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973249.483160364) |
| TestStablecoin (tUSDT, 6 dec.) | `0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a` | [0.0.11340006](https://hashscan.io/testnet/contract/0.0.11340006) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973289.919591005) |
| CashEthTaker | `0x506646D702C00A19854eE1f28eF3F396E32a3838` | [0.0.11340016](https://hashscan.io/testnet/contract/0.0.11340016) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973323.248921375) |

Wiring (one-time, from the operator), each read back from the chain:

| Step | Tx |
| --- | --- |
| `ReceivableRegistry.wire(facility, repaymentRouter)` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793971547.693584156) |
| `KYARegistry.wire(repaymentRouter, facility)` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793971571.194228108) |
| `ReceivableCreditNote.wire(facility, repaymentRouter, swapRouter, aqua)` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973375.185154979) |
| `CreditFacility.wire(swapRouter, repaymentRouter)` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973384.629786380) |

Hedera-native objects:

| Object | Id |
| --- | --- |
| HCS audit topic (`CashETH audit v1`, submit key = operator, no admin key) | [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927) |
| Receivable NFT collection (`CashETH Receivable` / `CRCV`) | [0.0.11338934](https://hashscan.io/testnet/token/0.0.11338934) |
| USDC (testnet) | [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) |

Demo agent accounts (ECDSA, 20 HBAR each, USDC associated):

| Agent | Account |
| --- | --- |
| seller | [0.0.11337987](https://hashscan.io/testnet/account/0.0.11337987) |
| buyer | [0.0.11337988](https://hashscan.io/testnet/account/0.0.11337988) |
| workerResearch | [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) |
| workerCompute | [0.0.11337990](https://hashscan.io/testnet/account/0.0.11337990) |
| lenderA | [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991) |
| lenderB | [0.0.11337992](https://hashscan.io/testnet/account/0.0.11337992) |
| lenderC | [0.0.11337993](https://hashscan.io/testnet/account/0.0.11337993) |
| lenderD | [0.0.11340117](https://hashscan.io/testnet/account/0.0.11340117) |
| coordinator | [0.0.11337994](https://hashscan.io/testnet/account/0.0.11337994) |
| cosigner | [0.0.11337995](https://hashscan.io/testnet/account/0.0.11337995) |
| kyaIssuer | [0.0.11337996](https://hashscan.io/testnet/account/0.0.11337996) |

Every agent has an HCS-14 UAID published as an `AgentRegistered` message on the audit topic. The UAIDs and sequence-number links are in [docs/EVIDENCE.md](docs/EVIDENCE.md), section "C2: HCS topic, HCS-14 profiles and receivable NFT collection".

## Payment flow

1. **Upload and confirm.** Seller agent: `upload_receivable`. Buyer agent signs the EIP-712 confirmation (payee = `RepaymentRouter`) and calls `confirm_receivable`.
2. **Register.** The coordinator calls `ReceivableRegistry.register`. The registry checks duplicate, buyer signature, payee, term (1 to 120 days), nonce, currency, KYA levels and owner separation. State becomes `Confirmed`; the NFT is minted and `ReceivableConfirmed` / `NftMinted` go to the HCS topic.
3. **Fund.** The seller agent calls `open_facility`. The coordinator calls `CreditFacility.openAndFund`, which fills the cheapest eligible lender strategies through `CashEthSwapVMRouter`. The credit opcode reads the live receivable state; the facility marks the id `Financed` in the same transaction.
4. **Spend.** Worker: `reserve_spend`, then `pay_x402`, then `commit_spend`. The facility moves exactly the reserved USDC into the worker's spend wallet; the co-signer approves the matching x402 transfer; the facilitator settles it. Unspent funds are released back.
5. **Repay.** The buyer agent calls `repay_receivable`. `RepaymentRouter` pays lenders (principal plus fee) first, the seller agent the remainder. The receivable becomes `Repaid`.
6. **Late.** The facility schedules its own overdue and default checks through the Hedera Schedule Service (HIP-1215). Repayment always works and always pays lenders first.

On-chain proof of the registration step (receivable PO-1002, id `0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c`):

| Item | Link |
| --- | --- |
| `ReceivableRegistry.register` (state `Confirmed`) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973922.254969725) |
| HCS `ReceivableConfirmed`, seq 30 | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793973943.240502909) |
| NFT serial 1 minted | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.419241023) |
| HCS `NftMinted`, seq 31 | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.577011440) |
| Same obligation submitted again: reverts `DUPLICATE_RECEIVABLE()` (`0x55e1137b`) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973975.081244937) |
| Unwired payee: reverts `WRONG_PAYEE()` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966502.770050429) |
| Tampered buyer signature: reverts `BAD_BUYER_SIG()` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966532.109597123) |

<!-- TODO(8.2-final): add the end-to-end demo run: openAndFund (Financed), reserve/commit spends, repay (Repaid), with HashScan links and the final receivable id. -->

## Modified SwapVM and Aqua

**Aqua registry.** We redeployed the official 1inch Aqua registry ourselves (`AquaRouter`, address above) with no source changes. 1inch does not deploy it on Hedera, so this registry is CashETH's own.

**Router.** `CashEthSwapVMRouter is Simulator, SwapVM, AquaOpcodes`: the same base and constructor arguments as 1inch's `AquaSwapVMRouter`, plus exactly one new instruction.

| Item | Value |
| --- | --- |
| Source | [contracts/src/aqua/CashEthSwapVMRouter.sol](contracts/src/aqua/CashEthSwapVMRouter.sol), [contracts/src/aqua/ReceivableCredit.sol](contracts/src/aqua/ReceivableCredit.sol) |
| Custom opcode | `ReceivableCredit` on the free slot `Opcode._21` (conditions bank) |
| Dropped to fit EIP-170 | `XYCConcentrateSwap`. With it the runtime is 24,650 B (74 over the limit); without it 23,759 B. A program using it reverts `UnknownOpcode`. CashETH ships no concentrated strategies. |
| Runtime size | 23,759 B (initcode 25,445 B, margin 817 B) |
| Immutables added | `REGISTRY`, `KYA`, `FACILITY` |
| Extra view | `exposure(maker, buyer)`: cumulative USDC a lender has advanced against a buyer (the `maxPerBuyer` cap applies to it) |
| EIP-712 domain | "CashETH SwapVM", "1.0.0", chain 296 |
| Order and taker bytes | Built on-chain by `CashEthOrderBuilder` via `eth_call`; nothing is hand-encoded off-chain |
| Deployed code check | All five C4 contracts were read back from the mirror node and matched `out/` byte for byte (immutables masked) |

Check the size yourself:

```
cd contracts && forge build --sizes | grep CashEthSwapVMRouter
| CashEthSwapVMRouter | 23,759 | 25,445 | 817 | 23,707 |
```

**What the opcode enforces on every fill** (first failure reverts the swap; see the header of `ReceivableCredit.sol`):

1. `taker == facility`. Only the credit facility can fill a credit strategy.
2. Taker args are exactly `[bytes32 id, uint16 advanceBps]`.
3. `registry.get(id).state == Confirmed` (the core rule: no confirmed receivable, no fill).
4. Seller filter: if the lender set a `sellerSet` the seller must be in it (score ignored); otherwise the seller's KYA reputation must meet `minSellerOnTime` and `maxSellerDefaults`. Failure: `SELLER_NOT_FUNDED_BY_LENDER`.
5. Remaining tenor is positive and at most `maxTenorDays`.
6. `advanceBps <= maxAdvanceBps`.
7. Buyer reputation `onTime >= minBuyerOnTime`.
8. Output token is the receivable's currency; direction is RCN to USDC.
9. The amount fits the strategy's Aqua balance and the lender's per-buyer exposure cap, and leaves at least `minReserve` USDC in the lender's wallet. Failure: `LENDER_RESERVE_TOO_LOW`.

Price is 1:1; the lender's yield is the `aprBps` recorded in its strategy. On a real swap (not a quote) the opcode adds to `exposure[maker][buyer]` and calls `facility.onCreditFill(id, maker, amount, aprBps)`.

**On-chain evidence for Aqua on Hedera**

| What | Link |
| --- | --- |
| Spike S1: unmodified `AquaRouter` and `AquaSwapVMRouter` deployed; lender A ships an XYC strategy | ship [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793963071.121512471) |
| Spike S1: `SpikeTaker.fill` swaps 0.1 TOKENB for 90,909 USDC units; the HTS child transfer debits lender A's allowance (`is_approval: true`) | fill [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153) |
| C4: our registry and modified router deployed | [registry tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973211.309180764), [router tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793973238.198619187) |
| C4: registry, router, RCN and facility wired | wiring table above |

<!-- TODO(8.2-final): credit strategies shipped by lenders A, B, C, D, and the `openAndFund` transaction in which the modified router fills A and B, skips C (price) and D (`SELLER_NOT_FUNDED_BY_LENDER`). Link the Aqua funding transaction id here. -->

Unit, fuzz and invariant tests are in `contracts/test/` (`ReceivableCredit.t.sol`, `CashEthSwapVMRouter.t.sol`, `CashEthTaker.t.sol`, `invariants/`). As recorded at C4 in EVIDENCE.md, `forge test` passed 182 of 182.

## Shared liquidity: base yield, credit boost, risk tiers

There is no pool contract and no external yield protocol. A lender's USDC stays in the lender's own wallet. One lender balance backs two strategies on `CashEthSwapVMRouter` (shared liquidity):

| Strategy | Program | Purpose |
| --- | --- | --- |
| Base yield | `Salt`, `FeeFlatIn`, `XYCSwap`: constant product over USDC / tUSDT, 30 bps fee | Earns swap fees from trading volume. Variable. |
| Credit (boost) | `Salt`, `ReceivableCredit(args)` over USDC / RCN | Sells USDC 1:1 for RCN against a confirmed receivable at the lender's fixed `aprBps`. |

The base APR is measured from real on-chain swaps made by a scripted trader agent through `CashEthTaker` against the tUSDT leg. It is labelled "scripted volume" wherever it is shown and is not a promised rate. The credit APR is the fixed leg. `tUSDT` is a plain 6-decimal test token we deployed (no HTS association needed). The C4 mints to each lender and to the trader account are in [docs/EVIDENCE.md](docs/EVIDENCE.md).

**Risk tiers** are presets of the credit opcode arguments, enforced by the opcode at fill time:

| Tier | aprBps | minSellerOnTime | maxSellerDefaults | minBuyerOnTime | maxPerBuyer (USDC units) | sellerSet |
| --- | --- | --- | --- | --- | --- | --- |
| low | 700 | 3 | 0 | 0 | 5,000,000 | optional allowlist |
| medium | 850 | 1 | 0 | 0 | 5,000,000 | optional allowlist |
| high | 1300 | 0 | 2 | 0 | 5,000,000 | empty (any seller) |

A non-empty `sellerSet` (up to 3 addresses) replaces the score thresholds: an explicit choice beats the score.

Demo lenders:

| Lender | Account | Tier | sellerSet | Designed outcome |
| --- | --- | --- | --- | --- |
| A | [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991) | low | seller | filled |
| B | [0.0.11337992](https://hashscan.io/testnet/account/0.0.11337992) | medium | seller | filled |
| C | [0.0.11337993](https://hashscan.io/testnet/account/0.0.11337993) | high | any | eligible but the most expensive, not needed |
| D | [0.0.11340117](https://hashscan.io/testnet/account/0.0.11340117) | low | workerResearch | skipped on-chain: `SELLER_NOT_FUNDED_BY_LENDER` |

The last column is the design. The observed run is linked once it exists.

<!-- TODO(8.2-final): measured per-lender yield table (baseFees, creditFees, capital, blendedApr) from `packages/stats`, with the trader's swap transaction links, labelled "scripted volume"; and the observed fill outcome for A, B, C, D. -->

## x402 spending

Hedera's `exact` scheme has the client sign a `TransferTransaction` that debits its own account, and the facilitator pays the network fee. A contract cannot sign that, so the facility cannot be the payer. CashETH uses **2-of-2 co-signed spend wallets**:

- Each worker has a Hedera account whose key is `KeyList([worker, cosigner], threshold 2)`. It is associated with USDC and holds zero balance between payments.
- `reserve` moves exactly the reserved USDC in from the facility; the worker signs the x402 transfer; the policy co-signer adds its signature only if `payTo`, asset and amount match the reservation and the merchant is allowlisted. Without the second signature the facilitator refuses the payment.
- Limits (per-agent budget, per-transaction, daily, merchant allowlist, facility-wide ceiling) are checked in the engine and again in `CreditFacility`, with the same error names: `AGENT_BUDGET_EXCEEDED`, `TX_LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`, `MERCHANT_NOT_ALLOWED`, `GLOBAL_CREDIT_LIMIT_EXCEEDED`.
- Scheme `exact`, network `hedera:testnet`, facilitator `https://x402.org/facilitator`. The settlement transaction id comes back in the `PAYMENT-RESPONSE` header.

Our merchant (`apps/merchant`): `GET /research?topic=...`, price 0.25 USDC to merchant account [0.0.11333304](https://hashscan.io/testnet/account/0.0.11333304), built on `@x402/core`, `@x402/express` and `@x402/hedera` 2.30.0.

Spend wallets (key and threshold read back from the mirror node and decoded in EVIDENCE.md):

| Wallet | Account | Create tx | USDC association tx (both signatures) |
| --- | --- | --- | --- |
| SPEND_WALLET_RESEARCH | [0.0.11339484](https://hashscan.io/testnet/account/0.0.11339484) | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793969914.172231452) | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793969919.209773850) |
| SPEND_WALLET_COMPUTE | [0.0.11339486](https://hashscan.io/testnet/account/0.0.11339486) | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793969922.674066550) | [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793969930.470415616) |

## Settled transactions

### x402 payment (Hedera track)

**Settled Hedera x402 transaction id (final demo run): TODO.**

<!-- TODO(8.2-final): settled x402 transaction id from the PAYMENT-RESPONSE header of the final demo run (HashScan link), paid by SPEND_WALLET_RESEARCH to the merchant. -->

Before the agents were integrated, spike S3 proved the same mechanism against our merchant on `hedera:testnet` with the public facilitator (`scripts/spikes/s3-x402.ts`). Both payments are 0.25 USDC (250,000 units) to the merchant. The facilitator account `0.0.9185802` pays the fee.

| Payment | Payer | Settlement transaction |
| --- | --- | --- |
| A: single ECDSA key | WORKER_RESEARCH [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) | [0.0.9185802@1793964900.434830214](https://hashscan.io/testnet/transaction/0.0.9185802-1793964900-434830214) |
| B: 2-of-2 KeyList (worker + co-signer) | spend wallet [0.0.11338499](https://hashscan.io/testnet/account/0.0.11338499) | [0.0.9185802@1793964918.249682742](https://hashscan.io/testnet/transaction/0.0.9185802-1793964918-249682742) |

Negative check: the same 2-of-2 wallet paying with the worker signature only was refused by the facilitator with HTTP 402 `invalid_exact_hedera_payload_signature_invalid`, and its USDC did not move.

### Aqua funding transaction (1inch track)

**Aqua funding transaction id (`openAndFund` through the modified router): TODO.**

<!-- TODO(8.2-final): the `CreditFacility.openAndFund` transaction id (HashScan link) showing the modified router filling lenders A and B and the receivable becoming Financed. -->

## Prize-track checklists

### Hedera: AI Agents That Pay (x402)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Own x402-protected endpoint | Done (spike) | `apps/merchant`; 402 `PaymentRequirements` and settled payments in [S3](#x402-payment-hedera-track) |
| Settles USDC on Hedera testnet through a listed facilitator | Done (spike) | S3 settlements above via `https://x402.org/facilitator` |
| Worker agent pays with no human approval | Pending | Final run transaction id (see the TODO under Settled transactions) |
| Spending controls | Contracts built and tested; on-chain run pending | `CreditFacility` budgets, limits and reservations; 2-of-2 spend wallets (table above); refused single-signature payment (S3) |
| Agent identity and reputation (HCS-14, ERC-8004-shaped) | Done | UAIDs on the audit topic; `KYARegistry` registrations in [docs/EVIDENCE.md](docs/EVIDENCE.md), section C2 |
| HCS audit log | Done for registration; spend events pending | Topic [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927), seq 30 and 31 |
| Settling in an HTS token | Done | USDC [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) |
| Scheduled Transactions (HIP-1215) | Mechanism proven; facility schedule pending | Spike S4: schedule [0.0.11338268](https://hashscan.io/testnet/schedule/0.0.11338268) executed by the network; schedule [0.0.11338283](https://hashscan.io/testnet/schedule/0.0.11338283) deleted before firing |
| Hedera Agent Kit | Not yet documented | See TODO below |

<!-- TODO(8.2-final): update the "Pending" rows above once the final demo run exists, and fill the Hedera Agent Kit row. -->

### 1inch: Build an Aqua App

| Requirement | Status | Evidence |
| --- | --- | --- |
| Redeploy Aqua on Hedera testnet | Done | Registry [0.0.11339989](https://hashscan.io/testnet/contract/0.0.11339989) |
| Modified SwapVM router | Done | [0.0.11339992](https://hashscan.io/testnet/contract/0.0.11339992); `ReceivableCredit` on `Opcode._21`; runtime 23,759 B |
| Custom instruction gates fills on real state | Done in code and tests | `ReceivableCredit.sol`; on-chain credit fill pending below |
| Lender strategies filled on-chain, token transfers visible on HashScan | Spike done; credit fill pending | S1 fill [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153); credit fill is the TODO under Settled transactions |
| Shared liquidity (base yield and credit boost from one balance) | Built; measured yield pending | [Shared liquidity](#shared-liquidity-base-yield-credit-boost-risk-tiers) |
| Commits spread across the event | See `git log` | |
| Attribution | Done | [Attribution and licenses](#attribution-and-licenses) |

## How to run

Requirements: Node 22 (`.nvmrc`), pnpm 11, [Foundry](https://book.getfoundry.sh/) and a funded Hedera testnet ECDSA operator account.

**Foundry is required for the contract deploys.** Install or update it with `foundryup`. On some machines `forge` on `PATH` is a different CLI (for example an Atlassian tool). Check that `forge --version` prints Foundry, or point the scripts at the real binary with `FORGE=/path/to/foundry/forge`.

```
git clone --recurse-submodules <repo>      # contracts/lib/{forge-std,openzeppelin-contracts,solidity-utils,aqua,swap-vm}
cp .env.example .env                       # operator, merchant, JSON-RPC relay, USDC ids, x402 facilitator
pnpm install
pnpm -r build
pnpm setup:accounts                        # creates the demo accounts, writes .env.accounts, funds them with USDC
(cd contracts && forge build && forge test)
pnpm abi:sync
```

Deploys go through the Hashio relay. Each script runs `forge script` with `--legacy --slow --skip-simulation` (forge's replay cannot execute the HTS and HSS system contracts), then does the wiring and read-backs in TypeScript:

```
FORGE=/path/to/foundry/forge pnpm tsx scripts/c2-register-demo.ts       # 01_DeployCore: KYARegistry, ReceivableRegistry
pnpm tsx scripts/c2-topic-and-nft.ts                                    # HCS topic, receivable NFT, HCS-14 profiles
FORGE=/path/to/foundry/forge pnpm tsx scripts/c3-deploy.ts              # 02_DeployFacility: RCN, CreditFacility, RepaymentRouter
pnpm tsx scripts/c5-spend-wallets.ts                                    # 2-of-2 spend wallets
FORGE=/path/to/foundry/forge pnpm tsx scripts/c4-deploy-and-wire.ts     # 03_DeployAqua: Aqua, router, order builder, tUSDT, taker
pnpm tsx scripts/c4-register.ts                                         # first registration and the duplicate rejection
```

Notes from testing on Hedera: HTS `approve(spender, type(uint256).max)` reverts (allowances are int64), so USDC approvals are bounded. A contract constructor that calls `associate()` costs about 1.0M gas. Contracts that hold HBAR are funded through `receive()` in a second transaction. Details and transaction links are in [docs/EVIDENCE.md](docs/EVIDENCE.md).

<!-- TODO(8.2-final): `pnpm demo` (full end-to-end run) does not exist yet. Add the command, expected output and runtime once the demo runner lands, and document starting `apps/auth-server`, `apps/mcp-server` and `apps/merchant` (ports from `.env`). -->

## Frontend and read API

The UI is a separate Next.js app on the branch `feat/nextjs-frontend` (directory `frontend/`; landing and docs pages from the Tranche UI design). It is merged and integrated last. It consumes the backend's read API:

| Endpoint | Returns |
| --- | --- |
| `GET /events` | lifecycle and audit events |
| `GET /agents` | agents and their stats |
| `GET /lenders` | lenders and measured yield |
| `GET /receivables/:id` | one receivable with evidence links |

Request and response types are documented in [docs/API.md](docs/API.md). That file lives on the MCP server branch and arrives with its merge.

<!-- TODO(8.2-final): after the frontend is merged, add run instructions (`pnpm -F @casheth/frontend dev`, `NEXT_PUBLIC_API_URL`) and confirm that docs/API.md is on main. -->

## Attribution and licenses

Powered by Aqua — © Degensoft Ltd 2025

- `CashEthSwapVMRouter` is derived from 1inch's SwapVM `AquaSwapVMRouter`. Its source is published under `LicenseRef-Degensoft-SwapVM-1.1` terms, with our changes marked and dated 2026-11-06.
- The Aqua registry is deployed unmodified. It is `LicenseRef-Degensoft-Aqua-Source-1.1` (source-available) and is redeployed on testnet only.
- Full notices: [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

## Rulings and known limitations

<!-- TODO(8.2-final): rulings and known limitations, to be written by the project owner. -->

## Next steps

- **Sybil resistance.** The demo uses a KYA allowlist with an issuer account. A production system needs real identity and owner-separation proofs.
- **Cross-registry reputation (IRN).** Let repayment reputation travel across registries instead of living in one `KYARegistry`.
- **GST evidence.** Accept India GST e-invoice data as additional evidence for a receivable. It would strengthen the buyer's signature, not replace it.

## Open items for the final pass

These are the `TODO(8.2-final)` placeholders in this file.

| Section | Missing |
| --- | --- |
| Payment flow | End-to-end demo run links |
| Modified SwapVM and Aqua | Credit strategy ships and the funding transaction |
| Shared liquidity | Measured yield table and observed A/B/C/D outcome |
| Settled transactions | Settled x402 transaction id; Aqua funding transaction id |
| Prize-track checklists | Final status of pending rows; Hedera Agent Kit |
| How to run | `pnpm demo`, service start commands |
| Frontend and read API | Run instructions after merge |
| Rulings and known limitations | Owner to write |
