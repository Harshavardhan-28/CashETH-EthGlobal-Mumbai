# Context: casheth-paid-apis

Last updated: 6 Nov 2026 (ETH Global Mumbai build)

## What this is

The **paid services** that the CashETH demo agent spends money on. Each endpoint costs
USDC and is paywalled with **x402 v2** on **Hedera testnet**. These play the role of
"third-party APIs an AI agent has to pay for", so the demo can show an agent using
CashETH credit to buy data per call.

This folder is only the paid API side. It is **not** CashETH itself (the MCP server,
contracts, credit facility, Aqua/SwapVM strategies, dashboard live elsewhere; see
`../eth-global/docs/BUILD.md`).

## Where it fits in the demo story ("The Broke Research Agent")

1. Lumen (seller agent) has a $100 invoice from Acme but $0 cash.
2. CashETH turns the invoice into an $80 credit line, backed by Priya's lender USDC.
3. **The worker agent pays these APIs via x402**: price-feed $0.50, web-scrape $1.00,
   llm-summary $2.00 = **$3.50 drawn**. Each payment is a real Hedera transaction.
4. **Guardrail scene**: the agent tries `/premium-data` ($5, different payee) and the
   spend policy refuses to sign.
5. Acme repays, lenders are paid first, Lumen keeps the rest.

Prizes this supports: **Hedera "AI Agents That Pay: x402"** (scenes 3 and 4).

## Endpoints

| Method | Path | Price | Notes |
|---|---|---|---|
| GET | `/price-feed?symbols=HBAR,ETH,BTC` | $0.50 | Demo oracle, realistic moving prices, no external API |
| GET | `/web-scrape?url=…` | $1.00 | Real fetch; blocks private/internal addresses (SSRF guard) |
| POST | `/llm-summary` `{"text","maxSentences"}` | $2.00 | Extractive summariser, no model key needed |
| GET | `/premium-data` | $5.00 | Pays `ROGUE_PAY_TO`; hidden unless that env var is set |
| GET | `/` | free | Catalogue |
| GET | `/health` | free | Use this on Cloud Run (`/healthz` is reserved there) |
| GET | `/receipts` | free | In-memory log of settled payments + HashScan links |

If a handler errors (bad input, upstream down), x402 does **not** settle, so the caller
is not charged.

## Live deployment

| Item | Value |
|---|---|
| URL | https://casheth-paid-apis-177290233934.asia-southeast1.run.app |
| GCP project | `codecell-vesit` |
| Region | `asia-southeast1` (Singapore) |
| Service | `casheth-paid-apis`, min 1 / max 1 instance (receipts stay in one place, no cold start) |
| Env vars | `PAY_TO=0.0.11333304`, `X402_NETWORK=hedera:testnet`, `FACILITATOR_URL=https://x402.org/facilitator` |

Redeploy (from this folder):

```bash
gcloud run deploy casheth-paid-apis --source . --region asia-southeast1 --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --set-env-vars "PAY_TO=0.0.11333304,X402_NETWORK=hedera:testnet,FACILITATOR_URL=https://x402.org/facilitator"
```

## Accounts (Hedera testnet, ECDSA)

| Role | Account | Status |
|---|---|---|
| Merchant (`PAY_TO`, receives payments) | `0.0.11333304` | USDC associated |
| Payer / agent spend wallet (`PAYER_ACCOUNT_ID`) | `0.0.11333252` | USDC associated, funded from Circle faucet |
| Rogue payee (`ROGUE_PAY_TO`) | not created yet | needed for the guardrail scene |

- USDC testnet token: `0.0.429274` (6 decimals).
- Facilitator fee payer (x402.org): `0.0.9185802`. Alternatives that support
  `hedera:testnet`: `https://api.testnet.blocky402.com`, `https://testnet.facilitator.launa.dev`.
- **Private keys live only in the local `.env`** (git- and gcloud-ignored). Never put keys
  in Cloud Run env vars; the server only needs the merchant account id.

## Tech

- Node 22, Express 5, `@x402/express` + `@x402/core` + `@x402/hedera` pinned at **2.28.0**.
- Plain ESM JavaScript, no build step.
- `Dockerfile`: `node:22-slim`, `npm ci --omit=dev`, `chmod -R a+rX /app`, runs as `node`.

```text
src/server.js     Express app, x402 paywall, routes, startup config check
src/services.js   The four paid handlers
src/config.js     Env settings (prices as plain numbers, e.g. 0.50)
src/receipts.js   In-memory settled-payment log
scripts/pay.mjs   Test client: pays with x402 from the payer account
```

## How to test

```bash
npm install
npm run dev                                   # local server on :8080 (reads .env)
npm run pay -- all                            # price-feed -> web-scrape -> llm-summary
npm run pay -- premium-data                   # rogue payee
npm run pay -- associate                      # associate PAYER_ACCOUNT_ID with USDC

export URL=https://casheth-paid-apis-177290233934.asia-southeast1.run.app
API_URL=$URL npm run pay -- all               # against Cloud Run
curl $URL/receipts
```

Client guardrails in `scripts/pay.mjs` (preview of CashETH's policy co-signer):
- `MAX_PAYMENT_USD` (default 5): refuse any single payment above this.
- `ALLOWED_PAY_TO` (comma list): refuse any other payee, e.g.
  `ALLOWED_PAY_TO=0.0.11333304 npm run pay -- premium-data` prints DENIED, nothing paid.

## Status

Version history (`version` is shown at `GET /` and `GET /health`):
- **0.1.0** (revision 00004): first live version. Full paid run on Cloud Run on
  6 Nov 23:36 IST: 3 calls, 3.50 USDC, all settled.
- **0.2.0**: cleaner `/web-scrape` text (menus, headers, footers, cookie banners dropped;
  prefers `<main>`/`<article>`) and readable `/llm-summary` output (real sentences only,
  no menu fragments, fixed spacing and citation marks). Adds `version` to `/` and `/health`.

Done:
- Service built, tested and live on Cloud Run; 402 responses correct (amount, asset, payee, https resource URL).
- Real payments settled on Hedera testnet, locally and on Cloud Run.
- Client guardrails (max amount, payee allowlist) tested locally.

Not done yet:
- Create the rogue account, associate with USDC, set `ROGUE_PAY_TO`, redeploy.
- Wire the CashETH worker agent / MCP `pay_x402` tool to call this URL.
- Show `/receipts` in the demo dashboard as the live spend feed.
- No git repo in this folder yet.

## Gotchas we hit (read before debugging)

1. **Hedera testnet maintenance.** 6 Nov 23:30 to 00:10 IST (upgrade to v0.79): every
   settlement failed with `transaction_failed … gRPC UNAVAILABLE / 503`. Nothing is
   charged. Check https://status.hedera.com before testing or demoing; switching
   facilitators does not help when testnet itself is down.
2. **`EACCES` on Cloud Run.** Files on the external SSD are mode 600; the image runs as
   the non-root `node` user. Fixed by `RUN chmod -R a+rX /app` in the Dockerfile.
3. **Missing env vars.** `.env` is never uploaded. Without `PAY_TO` the server now still
   starts, and `/health` plus the paid routes return 503 with the problem listed.
4. **`/healthz` returns a Google 404 on Cloud Run.** Paths ending in `z` are reserved; use `/health`.
5. **"rejected by spendControls.maxAmountPerPayment ($1)".** The x402 client's default
   cap is $1 per payment; `pay.mjs` raises it via `MAX_PAYMENT_USD`.
6. **`BadKeyError … expected hex or 32 bytes`.** The key must be exactly 64 hex characters
   after `0x` (ours had lost its last character when copied).
7. **Account ids, not keys, in `PAY_TO` / `ROGUE_PAY_TO`.** They take `0.0.x` ids.
8. Both payer and payee must be **associated with USDC** or the transfer fails with
   `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
