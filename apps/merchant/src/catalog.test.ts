import type { Env } from "@casheth/shared";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMerchantApp } from "./server.js";

const env = {
  X402_FACILITATOR_URL: "http://127.0.0.1:1",
  X402_NETWORK: "hedera:testnet",
  MERCHANT_ACCOUNT_ID: "0.0.7777",
  USDC_TOKEN_ID: "0.0.429274",
} as unknown as Env;

describe("GET /catalog", () => {
  it("lists research at 0.25 with the merchant payTo", async () => {
    const app = createMerchantApp(env, { publicUrl: "https://merchant.example" });
    const res = await request(app).get("/catalog");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      services: [
        {
          name: "research",
          description: "Topic research summary with sources",
          url: "https://merchant.example/research?topic=",
          method: "GET",
          price: "0.25",
          asset: "0.0.429274",
          decimals: 6,
          network: "hedera:testnet",
          payTo: "0.0.7777",
        },
      ],
    });
  });
});
