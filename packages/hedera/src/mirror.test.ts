import { loadEnv } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import { mirror } from "./mirror.js";

describe("mirror (live testnet)", () => {
  it("reads the operator account and reports an ECDSA key", async () => {
    const env = loadEnv();
    const account = await mirror.account(env, "0.0.11333252");
    expect(account.account).toBe("0.0.11333252");
    expect(account.key._type).toBe("ECDSA_SECP256K1");
  });
});
