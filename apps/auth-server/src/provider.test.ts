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
const DEMO_GRANT = { AUTH_DEMO_GRANT: "true" };

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

describe("demo grant switch", () => {
  it("serves no authorization-code grant unless AUTH_DEMO_GRANT=true", async () => {
    for (const env of [{}, { AUTH_DEMO_GRANT: "false" }, { AUTH_DEMO_GRANT: "1" }]) {
      const { app } = await testApp(env);
      await request(app)
        .post("/register")
        .send({ client_name: "x", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })
        .expect(404);
      await request(app).get("/authorize").query(authorizeQuery("any-client", pkce().challenge, { grant: "1" })).expect(404);
      const token = await request(app).post("/token").type("form").send({ grant_type: "authorization_code", code: "c", code_verifier: "v" }).expect(400);
      expect(token.body.error).toBe("unsupported_grant_type");

      const metadata = (await request(app).get("/.well-known/oauth-authorization-server").expect(200)).body as Record<string, unknown>;
      expect(metadata.grant_types_supported).toEqual([JWT_BEARER_GRANT]);
      expect(metadata).not.toHaveProperty("authorization_endpoint");
      expect(metadata).not.toHaveProperty("registration_endpoint");
      expect(metadata.token_endpoint).toBe(new URL("/token", ISSUER).href);
      expect((await request(app).get("/health").expect(200)).body.demoGrant).toBe(false);
    }
  });
});

describe("auth code + PKCE (demo grant page)", () => {
  it("auth-code + PKCE round trip issues a token for the chosen agent", async () => {
    const { app, kya } = await testApp(DEMO_GRANT);
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
    const { app, kya } = await testApp(DEMO_GRANT);
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

  it("agent:admin is never granted through the demo grant, whatever the request says", async () => {
    const { app, kya } = await testApp(DEMO_GRANT);
    const seller = newAgent(1, 2, {}, kya);
    const clientId = await registerClient(app);

    const page = await request(app).get("/authorize").query(authorizeQuery(clientId, pkce().challenge, { admin: "1", scope: "agent:admin credit:read" })).expect(200);
    expect(page.text).not.toContain('name="admin"');
    expect(page.text).not.toMatch(/with agent:admin/);

    const { verifier, challenge } = pkce();
    const code = await codeFor(app, clientId, challenge, { agent: seller.address, grant: "1", admin: "1", scope: "agent:admin credit:read" });
    const res = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier })
      .expect(200);
    expect(res.body.scope).toBe("credit:read");

    const adminOnly = await request(app)
      .get("/authorize")
      .query(authorizeQuery(clientId, pkce().challenge, { agent: seller.address, grant: "1", admin: "1", scope: "agent:admin" }))
      .expect(302);
    expect(new URL(adminOnly.headers.location as string).searchParams.get("error")).toBe("invalid_scope");
  });

  it("the consent page offers one choice per demo role (seller, buyer, worker, lender)", async () => {
    const { app, kya } = await testApp(DEMO_GRANT);
    const agents = [newAgent(1, 2, {}, kya), newAgent(2, 3, {}, kya), newAgent(3, 2, {}, kya), newAgent(4, 2, {}, kya)];
    const clientId = await registerClient(app);

    const page = await request(app).get("/authorize").query(authorizeQuery(clientId, pkce().challenge)).expect(200);
    for (const [i, role] of ["seller", "buyer", "worker", "lender"].entries()) {
      expect(page.text).toContain(`Act as ${role}`);
      expect(page.text).toContain(agents[i]!.address);
    }
  });

  it("issues a rotating refresh token bound to the client, the agent and the granted scopes", async () => {
    const { app, kya } = await testApp(DEMO_GRANT);
    const worker = newAgent(3, 2, {}, kya);
    const clientId = await registerClient(app);
    const otherClient = await registerClient(app);
    const { verifier, challenge } = pkce();
    const code = await codeFor(app, clientId, challenge, { agent: worker.address, grant: "1" });
    const first = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })
      .expect(200);
    expect(first.body.refresh_token).toEqual(expect.any(String));
    const refresh = (form: Record<string, string>) => request(app).post("/token").type("form").send({ grant_type: "refresh_token", ...form });

    expect((await refresh({ client_id: otherClient, refresh_token: first.body.refresh_token }).expect(400)).body.error).toBe("invalid_grant");
    const second = await refresh({ client_id: clientId, refresh_token: first.body.refresh_token, resource: RESOURCE.href }).expect(200);
    expect(second.body).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: first.body.scope });
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    const jwks = (await request(app).get("/.well-known/jwks.json").expect(200)).body as JSONWebKeySet;
    const { payload } = await jwtVerify<AccessTokenClaims>(second.body.access_token, createLocalJWKSet(jwks), { issuer: ISSUER.href, audience: RESOURCE.href });
    expect(payload).toMatchObject({ agent: worker.address, role: 3 });

    // Rotation: the used refresh token is gone.
    expect((await refresh({ client_id: clientId, refresh_token: first.body.refresh_token }).expect(400)).body.error).toBe("invalid_grant");
    // Narrowing is allowed, widening is not.
    expect((await refresh({ client_id: clientId, refresh_token: second.body.refresh_token, scope: "agent:admin" }).expect(400)).body.error).toBe("invalid_scope");
    const narrowed = await refresh({ client_id: clientId, refresh_token: second.body.refresh_token, scope: "receivable:read" }).expect(200);
    expect(narrowed.body.scope).toBe("receivable:read");

    // A revoked agent cannot refresh.
    kya.set(worker.address, { ...worker.record, revoked: true });
    const revoked = await refresh({ client_id: clientId, refresh_token: narrowed.body.refresh_token }).expect(400);
    expect(revoked.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/KYA_FAIL/) });
  });

  it("revoked agent cannot be granted on the demo page", async () => {
    const { app, kya } = await testApp(DEMO_GRANT);
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

  it("metadata advertises the code, refresh and jwt-bearer grants, S256 PKCE and dynamic registration", async () => {
    const { app } = await testApp(DEMO_GRANT);
    const res = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    expect(res.body.issuer).toBe(ISSUER.href);
    expect(res.body.grant_types_supported).toEqual(["authorization_code", "refresh_token", JWT_BEARER_GRANT]);
    expect(res.body.authorization_endpoint).toBe(new URL("/authorize", ISSUER).href);
    expect(res.body.registration_endpoint).toBe(new URL("/register", ISSUER).href);
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
    expect(info).toMatchObject({ token, clientId: lender.address, scopes: ["receivable:read", "credit:read", "stats:read", "lend:write"], resource: RESOURCE });
    expect(info.extra).toMatchObject({ agent: lender.address, role: 4, sub: lender.uaid });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const foreign = new CashEthOAuthProvider({ kya, keys: await tempKeys(), issuer: ISSUER, resource: RESOURCE });
    await expect(foreign.verifyAccessToken(token)).rejects.toThrow();
  });
});
