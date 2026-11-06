import type { Env } from "@casheth/shared";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadKeyRing } from "./accounts.js";
import { BUYER, BUYER_KEY, SELLER_KEY } from "./test/fixtures.js";

const LENDER_KEY = keccak256(toHex("test lender key"));
const COORDINATOR_KEY = keccak256(toHex("test coordinator key"));

const env = (extra: Record<string, string> = {}) =>
  ({
    BUYER_KEY: BUYER_KEY.slice(2), // .env.accounts may hold keys without 0x
    BUYER_ID: "0.0.1002",
    SELLER_KEY,
    SELLER_ID: "0.0.1001",
    LENDER_A_KEY: LENDER_KEY,
    LENDER_A_ID: "0.0.1005",
    COORDINATOR_KEY,
    COORDINATOR_ID: "0.0.1009",
    ...extra,
  }) as unknown as Env;

describe("loadKeyRing", () => {
  it("lists the agent accounts by role label, Hedera id and EVM address", () => {
    expect(loadKeyRing(env()).list()).toEqual([
      { account: "seller", role: "seller", accountId: "0.0.1001", address: privateKeyToAccount(SELLER_KEY).address },
      { account: "buyer", role: "buyer", accountId: "0.0.1002", address: BUYER.address },
      { account: "lender-a", role: "lender", accountId: "0.0.1005", address: privateKeyToAccount(LENDER_KEY).address },
    ]);
  });

  it("never holds the server's own keys (coordinator, co-signer, KYA issuer) or the workers' 2-of-2 halves", () => {
    const ring = loadKeyRing(env({ WORKER_RESEARCH_KEY: keccak256(toHex("worker")), COSIGNER_KEY: keccak256(toHex("cosigner")) }));
    expect(ring.list().map((a) => a.account)).toEqual(["seller", "buyer", "lender-a"]);
    expect(JSON.stringify(ring.list())).not.toContain(COORDINATOR_KEY.slice(2));
  });

  it("never exposes a key in what it lists", () => {
    const listed = JSON.stringify(loadKeyRing(env()).list());
    for (const key of [BUYER_KEY, SELLER_KEY, LENDER_KEY]) expect(listed).not.toContain(key.slice(2));
  });

  it("loads only the accounts WALLET_ACCOUNTS names", () => {
    expect(loadKeyRing(env({ WALLET_ACCOUNTS: "buyer" })).list().map((a) => a.account)).toEqual(["buyer"]);
  });

  it("refuses an account WALLET_ACCOUNTS names that the wallet may not hold", () => {
    expect(() => loadKeyRing(env({ WALLET_ACCOUNTS: "buyer,coordinator" }))).toThrow(/WALLET_ACCOUNTS.*coordinator/);
  });

  it("resolves an account by label and refuses an unknown one", () => {
    const ring = loadKeyRing(env());
    expect(ring.get("buyer").signer.address).toBe(BUYER.address);
    expect(() => ring.get("coordinator")).toThrow(/unknown account "coordinator"/);
  });
});
