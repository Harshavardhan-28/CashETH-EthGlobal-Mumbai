// Test client: pays the demo APIs with x402 from a Hedera testnet account.
//
//   npm run pay -- price-feed HBAR,ETH
//   npm run pay -- web-scrape https://hedera.com
//   npm run pay -- llm-summary "Some long text to summarise ..."
//   npm run pay -- all            (runs the three demo calls in order)
//   npm run pay -- premium-data   (the unapproved payee)
//   npm run pay -- associate      (associate the payer account with USDC)
//
// Env: API_URL, PAYER_ACCOUNT_ID, PAYER_PRIVATE_KEY (ECDSA hex or DER),
//      X402_NETWORK (default hedera:testnet), PAYMENT_ASSET (default 0.0.429274),
//      MAX_PAYMENT_USD (default 5): refuse any single payment above this,
//      ALLOWED_PAY_TO (optional, comma list of account ids): refuse other payees

import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import {
  createClientHederaSigner,
  PrivateKey,
  AccountId,
  Client,
  TokenAssociateTransaction,
  TokenId,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const API_URL = (process.env.API_URL || "http://localhost:8080").replace(/\/$/, "");
const NETWORK = process.env.X402_NETWORK || "hedera:testnet";
const ASSET = process.env.PAYMENT_ASSET || "0.0.429274";
const accountId = process.env.PAYER_ACCOUNT_ID;
const rawKey = process.env.PAYER_PRIVATE_KEY;

if (!accountId || !rawKey) {
  console.error("Set PAYER_ACCOUNT_ID and PAYER_PRIVATE_KEY (see .env.example).");
  process.exit(1);
}

// Accepts an ECDSA key as 0x-hex / raw hex (64 chars) or DER hex (from the portal).
function parseKey(raw) {
  const k = raw.trim().replace(/^["']|["']$/g, "");
  const hex = k.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("PAYER_PRIVATE_KEY must be hex (0x + 64 hex characters, or the DER hex from the portal).");
  }
  if (hex.length === 64) return PrivateKey.fromStringECDSA(hex);
  if (hex.length > 64 && hex.toLowerCase().startsWith("30")) return PrivateKey.fromStringDer(hex);
  throw new Error(
    `PAYER_PRIVATE_KEY has ${hex.length} hex characters after 0x; an ECDSA key needs 64. ` +
      "It was probably cut off when copying; copy it again from portal.hedera.com.",
  );
}
const privateKey = parseKey(rawKey);

async function associate() {
  const client = (NETWORK.endsWith("mainnet") ? Client.forMainnet() : Client.forTestnet()).setOperator(
    AccountId.fromString(accountId),
    privateKey,
  );
  try {
    const receipt = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTokenIds([TokenId.fromString(ASSET)])
      .execute(client)
      .then((r) => r.getReceipt(client));
    console.log(`Associated ${accountId} with ${ASSET}: ${receipt.status.toString()}`);
  } catch (err) {
    if (String(err).includes("TOKEN_ALREADY_ASSOCIATED")) console.log(`${accountId} is already associated with ${ASSET}.`);
    else throw err;
  } finally {
    client.close();
  }
}

const signer = createClientHederaSigner(accountId, privateKey, { network: NETWORK });
// Client-side guardrails. The x402 client refuses to sign anything over
// MAX_PAYMENT_USD (library default is $1) or to a payee not in ALLOWED_PAY_TO.
const maxPaymentUsd = Number(process.env.MAX_PAYMENT_USD || 5);
const allowedPayTo = (process.env.ALLOWED_PAY_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
const client = x402Client.fromConfig({
  schemes: [{ network: "hedera:*", client: new ExactHederaScheme(signer) }],
  spendControls: { maxAmountPerPayment: `$${maxPaymentUsd}` },
  policies: allowedPayTo.length ? [(version, reqs) => reqs.filter((r) => allowedPayTo.includes(r.payTo))] : [],
});
const payFetch = wrapFetchWithPayment(fetch, client);

async function call(label, path, init) {
  const started = Date.now();
  let res;
  try {
    res = await payFetch(`${API_URL}${path}`, init);
  } catch (err) {
    console.log(`\n== ${label}  DENIED by client guardrail (nothing was paid)`);
    console.log(`   ${err.message.split(". ")[0]}`);
    return null;
  }
  const header = res.headers.get("PAYMENT-RESPONSE") || res.headers.get("X-PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  const body = await res.json().catch(() => null);
  console.log(`\n== ${label}  HTTP ${res.status}  (${Date.now() - started} ms)`);
  if (settlement && !settlement.success) {
    // Payment was valid but could not be settled on Hedera (nothing was charged).
    console.log(`   settlement failed: ${settlement.errorReason || "unknown"}`);
    if (settlement.errorMessage) console.log(`   ${settlement.errorMessage.slice(0, 200)}`);
    console.log("   If this mentions UNAVAILABLE/503, Hedera testnet may be down: https://status.hedera.com");
  } else if (res.status === 402) {
    const required = res.headers.get("PAYMENT-REQUIRED");
    const reason = required ? decodePaymentRequiredHeader(required).error : null;
    console.log(`   payment not accepted: ${reason || "unknown reason"}`);
  }
  if (settlement?.success) {
    console.log(`   paid: tx ${settlement.transaction} by ${settlement.payer}`);
    console.log(`   https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`);
  }
  console.log(JSON.stringify(body, null, 2).split("\n").slice(0, 25).join("\n"));
  return body;
}

const [cmd = "all", ...args] = process.argv.slice(2);
const sampleText =
  "Hedera is a public ledger that settles transactions in a few seconds with low, fixed fees. " +
  "The x402 standard lets AI agents pay for web APIs over plain HTTP using stablecoins such as USDC. " +
  "When an agent calls a paid endpoint it receives 402 Payment Required, signs a payment and retries. " +
  "CashETH gives agent teams USDC credit backed by confirmed receivables. " +
  "That lets an agent buy the data it needs today and repay when its customer pays the invoice.";

switch (cmd) {
  case "associate":
    await associate();
    break;
  case "price-feed":
    await call("price-feed", `/price-feed?symbols=${encodeURIComponent(args[0] || "HBAR,ETH,BTC")}`);
    break;
  case "web-scrape":
    await call("web-scrape", `/web-scrape?url=${encodeURIComponent(args[0] || "https://hedera.com")}`);
    break;
  case "llm-summary":
    await call("llm-summary", "/llm-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: args.join(" ") || sampleText, maxSentences: 3 }),
    });
    break;
  case "premium-data":
    await call("premium-data", "/premium-data");
    break;
  case "all": {
    await call("price-feed", "/price-feed?symbols=HBAR,ETH,BTC");
    const page = await call("web-scrape", `/web-scrape?url=${encodeURIComponent("https://hedera.com")}`);
    await call("llm-summary", "/llm-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: page?.text || sampleText, maxSentences: 3 }),
    });
    break;
  }
  default:
    console.error(`Unknown command "${cmd}". Use price-feed | web-scrape | llm-summary | premium-data | all | associate`);
    process.exit(1);
}
