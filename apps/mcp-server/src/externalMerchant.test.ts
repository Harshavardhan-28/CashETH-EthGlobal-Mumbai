/**
 * An external x402 merchant (`casheth-paid-apis`) through reserve -> pay -> commit: its payee and origin are admitted
 * by `MERCHANT_ORIGINS`, and its `/premium-data`, whose 402 names a different payee, is refused by the co-signer.
 */
import { longZeroEvmAddress } from "@casheth/hedera";
import type { Env } from "@casheth/shared";
import { getAddress, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { merchantOrigins } from "./config.js";
import { fakeOrchestrator, NOW, testApp, type TestOrchestrator } from "./test/fakes.js";
import { callTool } from "./test/rpc.js";

const PAID_APIS = "https://casheth-paid-apis-177290233934.asia-southeast1.run.app";
const PAYEE = "0.0.11333304";
const ROGUE_PAYEE = "0.0.6666";
const SPEND_WALLET_ID = "0.0.11339484";
const USDC = "0.0.429274";

const worker = getAddress("0x00000000000000000000000000000000000000d1");
const spendWallet = getAddress("0x0000000000000000000000000000000000ad06dc");
const merchant = longZeroEvmAddress(PAYEE);
const facility = keccak256(toHex("receivable-1"));
const spendId = keccak256(toHex("spend-price-feed"));

async function setup() {
  const o = fakeOrchestrator() as TestOrchestrator;
  o.config.merchantOrigins = merchantOrigins({ MERCHANT_ACCOUNT_ID: "0.0.9001", MERCHANT_ORIGINS: `${PAYEE}=${PAID_APIS}/` } as unknown as Env);
  // The reservation the worker made for the payee read from the merchant's catalogue: 0.50 USDC, within maxPerTx.
  o.chain.reservations.set(spendId.toLowerCase(), {
    id: facility,
    worker,
    spendWallet,
    merchant,
    amount: 500_000n,
    expiry: NOW + 300n,
    status: 1,
    txIdHash: `0x${"0".repeat(64)}`,
  });
  o.x402.accounts.set(spendWallet.toLowerCase(), SPEND_WALLET_ID);
  o.x402.accounts.set(merchant.toLowerCase(), PAYEE);
  const t = await testApp(o);
  const token = await t.issuer.mint({ agent: worker, role: 3, level: 2, scope: "receivable:read credit:read spend:reserve spend:pay spend:commit stats:read" });
  return { ...t, o, token };
}

describe("pay_x402 against casheth-paid-apis", () => {
  it("pays /price-feed: its origin and payee are admitted, and the 402 matches the reservation", async () => {
    const { app, token, o } = await setup();
    o.x402.requirements = { scheme: "exact", network: "hedera:testnet", asset: USDC, payTo: PAYEE, amount: "500000" };
    const { result, json } = await callTool(app, token, "pay_x402", { spendId, url: `${PAID_APIS}/price-feed?symbols=HBAR`, idempotencyKey: "pay-price-feed" });
    expect(result.isError).toBeUndefined();
    expect(json).toMatchObject({ transactionId: "0.0.5005@1800000000.000000001" });
    expect(o.x402.payments).toEqual([`${PAID_APIS}/price-feed?symbols=HBAR`]);
  });

  it("refuses /premium-data: its 402 names a rogue payee, so the co-signer does not sign and SpendRejected is recorded", async () => {
    const { app, token, o } = await setup();
    // What the merchant answers for GET /premium-data: another payee, and 5 USDC.
    o.x402.requirements = { scheme: "exact", network: "hedera:testnet", asset: USDC, payTo: ROGUE_PAYEE, amount: "5000000" };
    const { result, json } = await callTool(app, token, "pay_x402", { spendId, url: `${PAID_APIS}/premium-data`, idempotencyKey: "pay-premium-data" });
    expect(result.isError).toBe(true);
    expect(json).toMatchObject({ code: "COSIGNER_REFUSED", reason: "wrong_payee", spendId });
    expect(o.x402.cosigned).toEqual([]);
    expect(o.events.list().at(-1)).toMatchObject({ type: "SpendRejected", spendId, code: "COSIGNER_REFUSED", reason: "wrong_payee", stage: "cosigner" });
  });

  it("refuses the rogue payee even when it asks for the reserved amount", async () => {
    const { app, token, o } = await setup();
    o.x402.requirements = { scheme: "exact", network: "hedera:testnet", asset: USDC, payTo: ROGUE_PAYEE, amount: "500000" };
    const { json } = await callTool(app, token, "pay_x402", { spendId, url: `${PAID_APIS}/premium-data`, idempotencyKey: "pay-premium-data-cheap" });
    expect(json).toMatchObject({ code: "COSIGNER_REFUSED", reason: "wrong_payee" });
    expect(o.x402.cosigned).toEqual([]);
  });

  it("does not fetch an origin that was not configured, even on the same host name pattern", async () => {
    const { app, token, o } = await setup();
    const { json } = await callTool(app, token, "pay_x402", { spendId, url: "https://casheth-paid-apis-177290233934.asia-southeast1.run.app.evil.example/price-feed", idempotencyKey: "pay-evil" });
    expect(json).toMatchObject({ code: "MERCHANT_URL_NOT_ALLOWED" });
    expect(o.x402.payments).toEqual([]);
  });
});
