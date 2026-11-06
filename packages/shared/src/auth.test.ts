import { decodeJwt, decodeProtectedHeader, type JWK } from "jose";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { evmAddressFromJwk, ROLE_SCOPES, scopesForRole, signAgentAssertion } from "./auth.js";

const MANDATE = `0x${"ab".repeat(32)}` as const;

describe("signAgentAssertion", () => {
  it("embeds the signer's public JWK and claims iss = its EVM address, exp = iat + 300", async () => {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    const jwt = await signAgentAssertion({
      privateKey,
      uaid: "uaid:aid:seller",
      audience: "http://localhost:4020/",
      mandateHash: MANDATE,
    });

    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe("ES256K");
    expect(header.jwk).toEqual({ kty: "EC", crv: "secp256k1", x: expect.any(String), y: expect.any(String) });
    expect(evmAddressFromJwk(header.jwk as JWK)).toBe(address);

    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ iss: address, sub: "uaid:aid:seller", aud: "http://localhost:4020/", mandateHash: MANDATE });
    expect(claims.exp! - claims.iat!).toBe(300);
    expect(claims.jti).toMatch(/.{16,}/);
    expect(claims).not.toHaveProperty("kya_evidence");
  });
});

describe("scopesForRole", () => {
  it("level 2 seller gets the full seller row", () => {
    expect(scopesForRole(1, 2)).toEqual([...ROLE_SCOPES[1]!]);
  });

  it("level 1 gets read scopes only", () => {
    expect(scopesForRole(3, 1)).toEqual(["receivable:read", "credit:read"]);
  });

  it("level 0 and unknown roles get nothing", () => {
    expect(scopesForRole(1, 0)).toEqual([]);
    expect(scopesForRole(9, 2)).toEqual([]);
  });
});
