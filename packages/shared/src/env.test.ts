import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const valid = {
  HEDERA_NETWORK: "testnet",
  HEDERA_CHAIN_ID: "296",
  HEDERA_JSON_RPC_URL: "https://testnet.hashio.io/api",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  HEDERA_OPERATOR_ID: "0.0.1001",
  HEDERA_OPERATOR_KEY: "0xoperator",
  MERCHANT_ACCOUNT_ID: "0.0.1002",
  MERCHANT_KEY: "0xmerchant",
  USDC_TOKEN_ID: "0.0.429274",
  USDC_EVM_ADDRESS: "0x0000000000000000000000000000000000068cda",
  X402_FACILITATOR_URL: "https://facilitator.example",
  X402_NETWORK: "hedera-testnet",
};

describe("loadEnv", () => {
  it("throws when HEDERA_OPERATOR_KEY missing", () => {
    const { HEDERA_OPERATOR_KEY: _omit, ...source } = valid;
    expect(() => loadEnv({ source })).toThrow(/HEDERA_OPERATOR_KEY/);
  });

  it("parses chain id 296 as number", () => {
    const env = loadEnv({ source: valid });
    expect(env.HEDERA_CHAIN_ID).toBe(296);
  });
});
