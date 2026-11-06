import { createHash, randomBytes } from "node:crypto";
import { type AccessTokenClaims, signAgentAssertion } from "@casheth/shared";
import type { Application } from "express";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { JWT_BEARER_GRANT } from "./jwtBearer.js";
import { CashEthOAuthProvider } from "./provider.js";
import { ISSUER, MANDATE, newAgent, RESOURCE, tempKeys, testApp } from "./test/fixtures.js";

const REDIRECT = "http://localhost:6274/oauth/callback";

async function registerClient(app: Application): Promise<string> {
  const res = await request(app)
    .post("/register")
    .send({ client_name: "demo IDE", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] })
    .expect(201);
  return res.body.client_id as string;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    resource: RESOURCE.href,
    ...extra,
  };
}

async function codeFor(app: Application, clientId: string, challenge: string, extra: Record<string, string>) {
  const res = await request(app).get("/authorize").query(authorizeQuery(clientId, challenge, extra)).expect(302);
  const location = new URL(res.headers.location as string);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st-123");
  expect(location.searchParams.get("error")).toBeNull();
  return location.searchParams.get("code")!;
}

describe("auth code + PKCE (demo grant page)", () => {
  it("auth-code + PKCE round trip issues a token for the chosen agent", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);
    const buyer = newAgent(2, 2, {}, kya);
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkce();

    const page = await request(app).get("/authorize").query(authorizeQuery(clientId, challenge)).expect(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain(seller.address);
    expect(page.text).toContain(buyer.address);

    const code = await codeFor(app, clientId, challenge, { agent: buyer.address, grant: "1", scope: "receivable:confirm repay:write facility:open" });

    const res = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE.href })
      .expect(200);
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: "receivable:confirm repay:write" });

    const jwks = (await request(app).get("/.well-known/jwks.json").expect(200)).body as JSONWebKeySet;
    const { payload } = await jwtVerify<AccessTokenClaims>(res.body.access_token, createLocalJWKSet(jwks), {
      issuer: ISSUER.href,
      audience: RESOURCE.href,
    });
    expect(payload).toMatchObject({ agent: buyer.address, role: 2, kya_level: 2, owner_group: buyer.record.ownerGroup, scope: "receivable:confirm repay:write" });

    // codes are single-use
    await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })
      .expect(400);
  });

  it("auth-code with a wrong code_verifier is rejected", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);
    const clientId = await registerClient(app);
    const { challenge } = pkce();
    const code = await codeFor(app, clientId, challenge, { agent: seller.address, grant: "1" });

    const res = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce().verifier, redirect_uri: REDIRECT })
      .expect(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("agent:admin is granted only with the admin=1 demo switch", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);
    const clientId = await registerClient(app);

    const plain = pkce();
    const plainCode = await codeFor(app, clientId, plain.challenge, { agent: seller.address, grant: "1", scope: "agent:admin credit:read" });
    const plainRes = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code: plainCode, code_verifier: plain.verifier })
      .expect(200);
    expect(plainRes.body.scope).toBe("credit:read");

    const admin = pkce();
    const adminCode = await codeFor(app, clientId, admin.challenge, { agent: seller.address, grant: "1", admin: "1", scope: "agent:admin credit:read" });
    const adminRes = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code: adminCode, code_verifier: admin.verifier })
      .expect(200);
    expect(adminRes.body.scope).toBe("credit:read agent:admin");
  });

  it("revoked agent cannot be granted on the demo page", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, { revoked: true }, kya);
    const clientId = await registerClient(app);

    const res = await request(app)
      .get("/authorize")
      .query(authorizeQuery(clientId, pkce().challenge, { agent: seller.address, grant: "1" }))
      .expect(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toMatch(/KYA_FAIL/);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("metadata advertises the jwt-bearer grant and S256 PKCE", async () => {
    const { app } = await testApp();
    const res = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    expect(res.body.issuer).toBe(ISSUER.href);
    expect(res.body.grant_types_supported).toEqual(["authorization_code", JWT_BEARER_GRANT]);
    expect(res.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(res.body.jwks_uri).toBe(new URL("/.well-known/jwks.json", ISSUER).href);
  });
});

describe("CashEthOAuthProvider.verifyAccessToken", () => {
  it("returns AuthInfo for its own tokens and rejects tokens signed by another key", async () => {
    const { app, kya, keys } = await testApp();
    const lender = newAgent(4, 2, {}, kya);
    const assertion = await signAgentAssertion({ privateKey: lender.privateKey, uaid: lender.uaid, audience: ISSUER.href, mandateHash: MANDATE });
    const res = await request(app).post("/token").type("form").send({ grant_type: JWT_BEARER_GRANT, assertion, resource: RESOURCE.href }).expect(200);
    const token = res.body.access_token as string;

    const info = await new CashEthOAuthProvider({ kya, keys, issuer: ISSUER, resource: RESOURCE }).verifyAccessToken(token);
    expect(info).toMatchObject({ token, clientId: lender.address, scopes: ["receivable:read", "credit:read"], resource: RESOURCE });
    expect(info.extra).toMatchObject({ agent: lender.address, role: 4, sub: lender.uaid });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const foreign = new CashEthOAuthProvider({ kya, keys: await tempKeys(), issuer: ISSUER, resource: RESOURCE });
    await expect(foreign.verifyAccessToken(token)).rejects.toThrow();
  });
});
