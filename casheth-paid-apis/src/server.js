import { readFileSync } from "node:fs";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

import { config, validateConfig } from "./config.js";
import { recordReceipt, listReceipts } from "./receipts.js";
import { priceFeed, webScrape, llmSummary, premiumData } from "./services.js";

// On a bad config we still start and listen (so Cloud Run deploys and the
// error is visible), but every non-free route returns 503 with the reason.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const problems = validateConfig();
if (problems.length) {
  console.error("Configuration error:\n - " + problems.join("\n - "));
}

// ---------- Catalogue of paid endpoints ----------

const services = [
  {
    key: "GET /price-feed",
    price: config.prices.priceFeed,
    payTo: config.payTo,
    description: "Live-style token prices in USD (demo oracle)",
    example: "/price-feed?symbols=HBAR,ETH,BTC",
  },
  {
    key: "GET /web-scrape",
    price: config.prices.webScrape,
    payTo: config.payTo,
    description: "Fetch a public web page and return its title, description and clean text",
    example: "/web-scrape?url=https://hedera.com",
  },
  {
    key: "POST /llm-summary",
    price: config.prices.llmSummary,
    payTo: config.payTo,
    description: "Summarise text into a few key sentences and keywords",
    example: 'POST /llm-summary {"text": "...", "maxSentences": 3}',
  },
];

if (config.roguePayTo) {
  services.push({
    key: "GET /premium-data",
    price: config.prices.premiumData,
    payTo: config.roguePayTo,
    description: "Premium signals from a payee that is NOT on CashETH's allowlist (guardrail demo)",
    example: "/premium-data",
  });
}

// ---------- App ----------

const app = express();
app.set("trust proxy", true); // Cloud Run terminates TLS; keeps resource URLs https
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Open CORS so a browser dashboard can call the APIs and read x402 headers.
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Free endpoints (registered before the paywall).
app.get("/", (req, res) => {
  res.json({
    name: "CashETH demo paid APIs",
    version,
    protocol: "x402 v2",
    network: config.network,
    asset: { id: config.asset, symbol: "USDC", decimals: config.assetDecimals },
    facilitator: config.facilitatorUrl,
    paywall: config.paywallDisabled ? "disabled" : "enabled",
    services: services.map(({ key, price, payTo, description, example }) => {
      const [method, path] = key.split(" ");
      return { method, path, price, payTo, description, example };
    }),
    free: ["GET /", "GET /health", "GET /receipts"],
  });
});

// Cloud Run reserves paths ending in "z" (e.g. /healthz), so /health is the one to use there.
const health = (req, res) => res.json({ ok: problems.length === 0, version, problems });
app.get("/health", health);
app.get("/healthz", health);
app.get("/receipts", (req, res) => res.json(listReceipts()));

// Paywall.
if (problems.length) {
  app.use((req, res) =>
    res.status(503).json({ error: "misconfigured", problems, hint: "Set the env vars and redeploy" }),
  );
} else if (config.paywallDisabled) {
  console.warn("PAYWALL_DISABLED=true: paid endpoints are free.");
} else {
  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 60_000 });

  const resourceServer = new x402ResourceServer(facilitator)
    .register(
      "hedera:*",
      new ExactHederaScheme({
        defaultAssets: {
          [config.network]: { asset: config.asset, decimals: config.assetDecimals },
        },
      }),
    )
    .onAfterSettle(async (ctx) => {
      if (ctx.result?.success) recordReceipt(ctx, config.assetDecimals);
    })
    .onVerifyFailure(async (ctx) => {
      console.warn(JSON.stringify({ event: "verify_failed", resource: ctx.paymentPayload?.resource?.url, error: ctx.error?.message }));
    })
    .onSettleFailure(async (ctx) => {
      console.warn(JSON.stringify({ event: "settle_failed", resource: ctx.paymentPayload?.resource?.url, error: ctx.error?.message }));
    });

  const routes = Object.fromEntries(
    services.map((s) => [
      s.key,
      {
        accepts: [
          {
            scheme: "exact",
            network: config.network,
            price: s.price,
            payTo: s.payTo,
            maxTimeoutSeconds: 180,
          },
        ],
        description: s.description,
        mimeType: "application/json",
      },
    ]),
  );

  app.use(paymentMiddleware(routes, resourceServer));
}

// Paid endpoints (only reached after payment is verified).
app.get("/price-feed", priceFeed);
app.get("/web-scrape", webScrape);
app.post("/llm-summary", llmSummary);
if (config.roguePayTo) app.get("/premium-data", premiumData);

app.use((req, res) => res.status(404).json({ error: "not_found", hint: "GET / lists the services" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: "internal_error", message: err.message });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `CashETH paid APIs on :${config.port} | ${config.network} | payTo ${config.payTo || "-"} | facilitator ${config.facilitatorUrl}`,
  );
});
