import { describe, expect, it } from "vitest";
import { buildUaid } from "./hcs14.js";
import { parseHcs14Did } from "./standardsSdk.js";

const seller = {
  evmAddress: "0x1111111111111111111111111111111111111111",
  accountId: "0.0.11337987",
  name: "CashETH Seller",
  role: "seller",
  network: "hedera:testnet",
} as const;

describe("buildUaid", () => {
  it('returns a string starting with "uaid:"', async () => {
    const { uaid } = await buildUaid(seller);
    expect(uaid.startsWith("uaid:")).toBe(true);
  });

  it("produces an HCS-14 AID UAID that routes to the Hedera account", async () => {
    const { uaid } = await buildUaid(seller);
    const parsed = parseHcs14Did(uaid);
    expect(parsed.method).toBe("aid");
    expect(parsed.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,}$/); // base58 of a SHA-384 digest
    expect(parsed.params).toMatchObject({
      uid: "0.0.11337987",
      nativeId: "hedera:testnet:0.0.11337987",
      proto: "mcp",
      registry: "casheth",
    });
  });

  it("is deterministic for the same input and differs per account", async () => {
    const a = await buildUaid(seller);
    const b = await buildUaid({ ...seller });
    const other = await buildUaid({ ...seller, accountId: "0.0.11337988" });
    expect(b.uaid).toBe(a.uaid);
    expect(other.uaid).not.toBe(a.uaid);
  });

  it("returns a profile carrying the uaid and the agent's public identity", async () => {
    const { uaid, profile } = await buildUaid(seller);
    expect(profile).toEqual({
      uaid,
      name: "CashETH Seller",
      role: "seller",
      accountId: "0.0.11337987",
      evmAddress: "0x1111111111111111111111111111111111111111",
      network: "hedera:testnet",
      version: 1,
    });
  });
});
