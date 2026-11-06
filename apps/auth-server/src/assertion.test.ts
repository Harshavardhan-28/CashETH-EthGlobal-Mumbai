import { signAgentAssertion } from "@casheth/shared";
import { decodeJwt } from "jose";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AuthError, verifyAgentAssertion } from "./assertion.js";
import { ISSUER, MANDATE, signRawAssertion } from "./test/fixtures.js";

const audience = ISSUER.href;

async function rejection(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  return error as AuthError;
}

describe("verifyAgentAssertion", () => {
  it("assertion signed by key X verifies and iss equals its address", async () => {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    const assertion = await signAgentAssertion({ privateKey, uaid: "uaid:aid:x", audience, mandateHash: MANDATE });

    const claims = await verifyAgentAssertion(assertion, { audience });

    expect(claims.iss).toBe(address);
    expect(claims.sub).toBe("uaid:aid:x");
    expect(claims.mandateHash).toBe(MANDATE);
    expect(claims.jwk).toMatchObject({ kty: "EC", crv: "secp256k1" });
  });

  it("assertion with mismatched iss is rejected", async () => {
    const signer = generatePrivateKey();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signRawAssertion(signer, {
      iss: other,
      sub: "uaid:aid:x",
      aud: audience,
      jti: "jti-mismatch",
      iat: now,
      exp: now + 300,
      mandateHash: MANDATE,
    });

    const error = await rejection(verifyAgentAssertion(assertion, { audience }));
    expect(error.code).toBe("invalid_grant");
    expect(error.description).toMatch(/iss/);
  });

  it("assertion with a tampered payload is rejected", async () => {
    const privateKey = generatePrivateKey();
    const assertion = await signAgentAssertion({ privateKey, uaid: "uaid:aid:x", audience, mandateHash: MANDATE });
    const [header, payload, signature] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "uaid:aid:someone-else" })).toString("base64url");

    const error = await rejection(verifyAgentAssertion(`${header}.${forged}.${signature}`, { audience }));
    expect(error.description).toMatch(/signature/);
  });

  it("expired assertion is rejected", async () => {
    const privateKey = generatePrivateKey();
    const assertion = await signAgentAssertion({ privateKey, uaid: "uaid:aid:x", audience, mandateHash: MANDATE });
    const { exp } = decodeJwt(assertion);

    const error = await rejection(verifyAgentAssertion(assertion, { audience, now: exp! + 60 }));
    expect(error.description).toMatch(/expired/);
  });

  it("assertion for another audience is rejected", async () => {
    const privateKey = generatePrivateKey();
    const assertion = await signAgentAssertion({ privateKey, uaid: "uaid:aid:x", audience: "https://evil.example/", mandateHash: MANDATE });

    const error = await rejection(verifyAgentAssertion(assertion, { audience }));
    expect(error.description).toMatch(/aud/);
  });
});
