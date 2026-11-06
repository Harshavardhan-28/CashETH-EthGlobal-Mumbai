# CashETH Paid APIs

Pay-per-call APIs for AI agents, paywalled with **[x402](https://x402.org) v2** and settled in **USDC on Hedera testnet**.

These are the "third-party services" the CashETH demo agent buys data from. The agent calls an endpoint, receives `402 Payment Required`, signs a USDC transfer, retries, and gets the data. No API keys, no accounts, no subscriptions.

**Live:** https://casheth-paid-apis-177290233934.asia-southeast1.run.app

## Endpoints

| Method | Path | Price | Returns |
|---|---|---|---|
| `GET` | `/price-feed?symbols=HBAR,ETH,BTC` | $0.50 | USD prices and 24h change (demo oracle; HBAR, ETH, BTC, USDC, SOL, INR) |
| `GET` | `/web-scrape?url=https://hedera.com` | $1.00 | Page title, description, word count and clean text (first 8,000 chars) |
| `POST` | `/llm-summary` | $2.00 | Summary, bullet sentences and keywords for the given text |
| `GET` | `/premium-data` | $5.00 | Pays a *different* payee (`ROGUE_PAY_TO`), used to demo a blocked payment. Hidden unless configured |
| `GET` | `/` | Free | Catalogue: services, prices, network, asset, payee |
| `GET` | `/receipts` | Free | Last 100 settled payments with HashScan links |
| `GET` | `/health` | Free | Status and version |

- **You are only charged on success.** If a handler fails (bad input, unreachable site), nothing settles.
- `/web-scrape` blocks private and internal addresses (SSRF guard).
- `/llm-summary` takes `{"text": "...", "maxSentences": 3}`. `text` must be at least 40 characters and `maxSentences` is 1–10.

## How payment works

```text
1. GET /price-feed                           -> 402 + PAYMENT-REQUIRED header
     scheme: exact · network: hedera:testnet · asset: 0.0.429274 (USDC)
     amount: 500000 (= 0.50 USDC) · payTo: 0.0.x
2. Client signs a USDC TransferTransaction
3. GET /price-feed + PAYMENT-SIGNATURE       -> 200 + data + PAYMENT-RESPONSE
     settlement: { success, transaction, payer, network }
```

A facilitator verifies and settles the transfer and pays the Hedera network fee, so the payer only needs USDC.

## Use the live API

Base URL: `https://casheth-paid-apis-177290233934.asia-southeast1.run.app`

```bash
export URL=https://casheth-paid-apis-177290233934.asia-southeast1.run.app
```

**1. Explore (free, no wallet needed)**

```bash
curl $URL/            # catalogue: services, prices, payee
curl $URL/health      # {"ok":true,"version":"0.2.0","problems":[]}
curl $URL/receipts    # settled payments with HashScan links
```

**2. See the paywall.** An unpaid call returns `402` with the payment terms in the `PAYMENT-REQUIRED` header (base64 JSON):

```bash
curl -i "$URL/price-feed?symbols=HBAR"        # HTTP/2 402
```

**3. Pay and get data.** Needs a funded payer account (see [Hedera account setup](#hedera-account-setup)). Clone this repo, set `PAYER_ACCOUNT_ID` and `PAYER_PRIVATE_KEY` in `.env`, then:

```bash
npm install
API_URL=$URL npm run pay -- all                          # price-feed + web-scrape + llm-summary ($3.50)
API_URL=$URL npm run pay -- price-feed HBAR,ETH
API_URL=$URL npm run pay -- web-scrape https://hedera.com
API_URL=$URL npm run pay -- llm-summary "Text to summarise..."
curl $URL/receipts                                       # your payments, with HashScan links
```

**4. Or call it from your own agent:**

```js
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const signer = createClientHederaSigner(
  "0.0.PAYER", PrivateKey.fromStringECDSA(process.env.PAYER_PRIVATE_KEY), { network: "hedera:testnet" },
);
const client = x402Client.fromConfig({
  schemes: [{ network: "hedera:*", client: new ExactHederaScheme(signer) }],
  spendControls: { maxAmountPerPayment: "$5" },   // refuse anything larger
});

const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://casheth-paid-apis-177290233934.asia-southeast1.run.app/price-feed?symbols=HBAR");
console.log(await res.json());
```

Spend guardrails: the x402 client refuses payments above `maxAmountPerPayment` (library default is $1) and can be given a policy to allow only specific payees. `npm run pay` exposes these as `MAX_PAYMENT_USD` and `ALLOWED_PAY_TO`.

## Run locally

Requires Node 20+ and the Hedera accounts from [Hedera account setup](#hedera-account-setup).

```bash
npm install
cp .env.example .env     # set PAY_TO (merchant), PAYER_ACCOUNT_ID, PAYER_PRIVATE_KEY
npm run dev              # server on http://localhost:8080 (auto-reloads)
```

Check it, then pay for calls from a second terminal (`API_URL` defaults to `http://localhost:8080`):

```bash
curl localhost:8080/health
curl -i "localhost:8080/price-feed?symbols=HBAR"     # 402 until paid
npm run pay -- all
curl localhost:8080/receipts
```

To build a UI without a wallet, set `PAYWALL_DISABLED=true` in `.env` and every endpoint is free.

## Hedera account setup

You need two ECDSA testnet accounts from [portal.hedera.com](https://portal.hedera.com):

| Role | Env var | Needs |
|---|---|---|
| Merchant (receives payments) | `PAY_TO` | Associated with USDC `0.0.429274` |
| Payer (agent wallet) | `PAYER_ACCOUNT_ID`, `PAYER_PRIVATE_KEY` | Associated with USDC, funded with test USDC from [faucet.circle.com](https://faucet.circle.com) (Hedera Testnet) |

Associate an account with USDC by putting it in `.env` as the payer and running `npm run pay -- associate`. Without association, transfers fail with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PAY_TO` | required | Merchant account id (`0.0.x`, not a key) |
| `ROGUE_PAY_TO` | empty | Payee for `/premium-data`; endpoint is hidden when empty |
| `X402_NETWORK` | `hedera:testnet` | `hedera:testnet` or `hedera:mainnet` |
| `PAYMENT_ASSET` | `0.0.429274` | HTS token id (USDC testnet, 6 decimals) |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Alternatives: `https://api.testnet.blocky402.com`, `https://testnet.facilitator.launa.dev` |
| `PRICE_PRICE_FEED` · `PRICE_WEB_SCRAPE` · `PRICE_LLM_SUMMARY` · `PRICE_PREMIUM_DATA` | `0.50` · `1.00` · `2.00` · `5.00` | Prices in USD, plain numbers |
| `PAYWALL_DISABLED` | `false` | `true` serves everything free (UI work) |

Never put private keys in server env vars. The server only needs the merchant account id.

## Deploy to Cloud Run

```bash
gcloud run deploy casheth-paid-apis --source . --region asia-southeast1 \
  --allow-unauthenticated --min-instances 1 --max-instances 1 \
  --set-env-vars "PAY_TO=0.0.11333304,X402_NETWORK=hedera:testnet,FACILITATOR_URL=https://x402.org/facilitator"
```

- `--allow-unauthenticated` is required: the x402 payment is the access control.
- Keep a single instance so `/receipts` (in memory) stays in one place.
- Use `/health` for checks; Cloud Run reserves paths ending in `z` such as `/healthz`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `transaction_failed … UNAVAILABLE / 503` | Hedera testnet is down or in maintenance. Check [status.hedera.com](https://status.hedera.com). Nothing is charged |
| `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` | Associate the payer or merchant with USDC |
| `rejected by spendControls.maxAmountPerPayment` | Raise `MAX_PAYMENT_USD` in the client |
| `invalid_exact_hedera_payload_signature_invalid` | Payer key does not match `PAYER_ACCOUNT_ID`, or is not ECDSA |
| `BadKeyError … expected hex or 32 bytes` | Key must be 64 hex characters after `0x`; re-copy it |
| Paid routes return 503 | A required env var (e.g. `PAY_TO`) is missing; `/health` lists the problem |

## Project layout

```text
src/server.js     Express app, x402 paywall, routes
src/services.js   Paid handlers
src/config.js     Environment settings
src/receipts.js   In-memory settled-payment log
scripts/pay.mjs   Test client that pays with x402
Dockerfile        Cloud Run image (node:22-slim, non-root)
```

Built with Express 5 and `@x402/express`, `@x402/core`, `@x402/hedera` (2.28.0).
