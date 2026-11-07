# Risk-priced credit: per-agent rates in three slabs, lender choice and yield comparison

Status: approved 2026-11-07 (decisions below).

## Intent

Today a seller's interest rate is whatever the cheapest lender strategy with liquidity charges (7%, 8.5% or 13%), so a
safe seller can pay 13% just because only a high-tier lender had money (PO-CC-11062242 did). The pitch is "the pool
lends and risk sets the price". This change makes the rate a function of the score alone, continuous inside three
slabs so that a slightly better agent always pays slightly less, and enforces it on chain. Lenders choose which risk
slabs (and optionally which agents) they back instead of setting prices, and the dashboard shows them what lending adds
on top of plain yield farming.

## Goals

1. **Rate from risk, enforced on chain.** The credit opcode computes the score and the rate on every fill from on-chain
   data; no lender, solver or server can charge a different rate.
2. **Three slabs, linear inside each, continuous across them.** Breakpoints (score -> APR):

   | Score | APR | Slab |
   | --- | --- | --- |
   | 750 (best possible) | 6.00% | low risk (700-750) |
   | 700 | 8.00% | low / medium boundary |
   | 600 | 11.00% | medium / high boundary |
   | 500 (lowest financeable) | 14.00% | high risk (500-599) |

   Piecewise linear between breakpoints, in basis points, floored: `650 -> 950 (9.5%)`, `725 -> 700 (7%)`,
   `520 -> 1340 (13.4%)`. Below 500 nothing is financed (unchanged). Scores above 750 cannot occur and clamp to 6%.
3. **Slab pools.** A lender's credit strategy names the slabs it funds (any of low, medium, high). A receivable is
   filled only by strategies that include its slab, at the receivable's rate.
4. **Lender picks agents.** A strategy may also name up to 3 sellers; then it fills only those sellers, and only when
   their receivable is in one of its slabs (the seller list narrows, it no longer bypasses the score).
5. **Lender sees the uplift.** Per lender: base (farming) APR, the credit APR it actually earns (principal-weighted
   rate of its positions), the blended APR, and the extra earned over farming alone.
6. **Everyone sees the price.** The receivable, `get_quotes`/`explain_decision`, `/agents`, `/receivables/:id` and the
   dashboard show the score, slab and rate behind every loan.

## Non-goals

- Compounding interest, a late-payment penalty rate, or rate changes after funding (the rate is fixed at fill).
- Changes to yield farming (the base-yield XYC strategy, its 30 bps fee and the scripted trader stay as they are).
- New score terms. The formula keeps its terms (base 600, +15 per on-time repayment capped at 10, -40 per late,
  -200 per default, -50 when the tenor exceeds 60 days); only its input changes, see Decisions.

## Anti-goals (a failure even if it works)

- A rate that depends on which lender has liquidity.
- Pricing computed off chain that the contracts do not enforce.
- Mock or simulated data anywhere: the new stack is deployed and exercised on Hedera testnet.

## Design

### Contracts (redeploy of the core stack; needs approval)

- New library `RiskPricing` (pure): `score(onTime, late, defaults, tenorSeconds) -> int`,
  `aprBps(score) -> uint16`, `slabOf(score) -> Slab {None, Low, Medium, High}`. Identical numbers to the TypeScript
  engine; parity is proven by tests that run the same table through both.
- `ReceivableCredit` args: replace `aprBps`, `minSellerOnTime`, `maxSellerDefaults` and `minBuyerOnTime` with
  `uint8 slabMask` (bit 0 low, bit 1 medium, bit 2 high; zero is invalid). Keep `maxTenorDays`, `maxAdvanceBps`,
  `maxPerBuyer`, `minReserve` and `sellerSet[0..3]`.
- Opcode checks: taker is the facility; receivable Confirmed; score from the reputation in `KYARegistry` and the
  remaining tenor; slab in `slabMask`; seller in `sellerSet` when it is non-empty; tenor, advance, exposure and
  reserve as today. It reports the computed `aprBps` through `facility.onCreditFill` (unchanged interface).
- `CreditFacility`: unchanged logic. All fills of one receivable carry the same rate, which the existing
  cheapest-first check accepts; the `FILL_MISMATCH` guard still requires the coordinator's fill rate to equal the
  opcode's. `RepaymentRouter` fee formula unchanged.
- Because `CreditFacility.wire` is one-time and the swap router, repayment router and RCN hold the facility as an
  immutable, the redeploy follows the earlier one (`scripts/c3-deploy.ts`, `scripts/c4-deploy-and-wire.ts`). Whether
  `KYARegistry` and `ReceivableRegistry` can be kept (and agent reputation with them) is decided by their wiring; the
  builder checks and reports before deploying.
- Lenders re-ship credit strategies to the new router with slab masks (ship moves no funds). Old strategies are
  docked. Receivables on the old stack stay there.

### Off-chain

- `packages/engine`: `rateFor(score)` and `slabOf(score)` next to `scoreReceivable`; `Decision` gains `slab` and
  `aprBps`.
- `packages/aqua`: credit-args encoding with `slabMask`; `LENDER_TIERS` presets become slab presets; the solver
  filters strategies by slab and seller set and fills largest available capacity first (every fill has the same rate,
  so fewer fills is better). Strategy discovery decodes the new args.
- MCP server: `fund_agents` takes `slabs: ("low"|"medium"|"high")[]` and optional `sellers` (at most 3) instead of a
  tier or raw args. `get_quotes`, `explain_decision`, `open_facility` and the `FacilityFunded` event carry score, slab
  and rate. `/lenders`: `slabs`, `sellers`, `baseApr`, `creditApr` (principal-weighted over the lender's positions),
  `blendedApr`, `extraEarned` (credit fees minus what the lent principal would have earned at `baseApr` over the same
  time). `/agents`: `slab` and `aprBps` next to `score`.
- Docs: README (pricing section, contract tables, evidence), `docs/API.md`, `docs/EVIDENCE.md`, `AGENTS.md`.

### Frontend (`frontend/`, the `/dashboard` lender view and the admin agents view)

- Lender view: "Farming only" vs "Farming + lending" APR and the extra earned; the slabs it funds; a table of
  sellers with score, slab and rate, marking the ones this lender backs and whether its slabs cover them.
- Agents views show each agent's slab and rate.
- How a lender changes its slabs or agents from the UI: open question 3.

## Constraints

- Hedera testnet only, real transactions; exact HTS approvals (no max approve); one `scheduleCall` per transaction.
- 1inch Aqua stays the funding path (prize track): lender USDC stays in lender wallets until a fill.
- No redeploy, re-ship or fund movement without the user's go-ahead.
- Small commits, no Co-Authored-By trailers; push main after every 5 commits.

## Decisions (user, 2026-11-07)

1. **Redeploy approved:** the core stack is redeployed on testnet and lenders re-ship their credit strategies.
2. **The score is the seller's own record:** the seller's `KYARegistry` reputation (on-time, late, defaults) plus the
   receivable's tenor, both on chain. This replaces the buyer reputation that `scoreReceivable` uses today, for the
   approval decision and the advance rate as well as the price, so one score drives every credit decision.
   The buyer's KYA level gate (level 3) stays.
3. **Lenders choose through the MCP tool:** `fund_agents` sets slabs and sellers; the dashboard shows the result
   (read only, no browser wallet).

## Calls made by the designer (check these)

- Rate breakpoints 6 / 8 / 11 / 14% at scores 750 / 700 / 600 / 500.
- Seller lists narrow a strategy instead of bypassing the score.
- Solver fills largest capacity first.
- `extraEarned` measured against the lender's own base APR.
