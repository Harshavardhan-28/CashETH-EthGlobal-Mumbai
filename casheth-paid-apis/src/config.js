// All settings come from environment variables so the same image runs
// locally and on Cloud Run. See .env.example for the full list.

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function usd(value, fallback) {
  const n = Number(String(value ?? "").replace(/^\$/, "") || fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid price: ${value}`);
  return `$${n.toFixed(2)}`;
}

export const config = {
  port: Number(env.PORT || 8080),

  // Hedera network in x402 (CAIP-2 style) form.
  network: env.X402_NETWORK || "hedera:testnet",

  // Account that receives every payment (your merchant account).
  payTo: env.PAY_TO || "",

  // A second account used only by /premium-data. CashETH's spend policy
  // does not allowlist it, so the demo can show a blocked payment.
  roguePayTo: env.ROGUE_PAY_TO || "",

  // HTS token used for payment. 0.0.429274 is Circle's USDC on Hedera testnet.
  asset: env.PAYMENT_ASSET || "0.0.429274",
  assetDecimals: Number(env.PAYMENT_ASSET_DECIMALS || 6),

  // Any facilitator that advertises hedera:testnet works.
  facilitatorUrl: env.FACILITATOR_URL || "https://x402.org/facilitator",

  // Set to true to serve the endpoints for free (local UI work, no wallet).
  paywallDisabled: bool(env.PAYWALL_DISABLED, false),

  // Prices in USD (paid as USDC). Kept small for the demo.
  // Plain numbers ("0.50"), so no "$" quoting trouble in shells or .env files.
  prices: {
    priceFeed: usd(env.PRICE_PRICE_FEED, "0.50"),
    webScrape: usd(env.PRICE_WEB_SCRAPE, "1.00"),
    llmSummary: usd(env.PRICE_LLM_SUMMARY, "2.00"),
    premiumData: usd(env.PRICE_PREMIUM_DATA, "5.00"),
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.paywallDisabled) {
    if (!/^0\.0\.\d+$/.test(config.payTo)) {
      problems.push("PAY_TO must be a Hedera account id like 0.0.123456");
    }
    if (config.roguePayTo && !/^0\.0\.\d+$/.test(config.roguePayTo)) {
      problems.push("ROGUE_PAY_TO must be a Hedera account id like 0.0.123456");
    }
  }
  return problems;
}
