import { type AccessTokenClaims, ROLE_SCOPES, signAgentAssertion } from "@casheth/shared";
import type { Application } from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from "jose";
import { keccak256 } from "viem";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOCK_SKEW_SECONDS } from "./assertion.js";
import { JtiReplayCache, JWT_BEARER_GRANT, handleJwtBearerGrant } from "./jwtBearer.js";
import { InMemoryKyaReader } from "./kya.js";
import { ISSUER, MANDATE, newAgent, RESOURCE, type TestAgent, tempKeys, testApp } from "./test/fixtures.js";

async function assertionFor(agent: TestAgent, extra: { mandateHash?: `0x${string}`; kyaEvidence?: string } = {}) {
  return signAgentAssertion({
    privateKey: agent.privateKey,
    uaid: agent.uaid,
    audience: ISSUER.href,
    mandateHash: extra.mandateHash ?? MANDATE,
    kyaEvidence: extra.kyaEvidence,
  });
}

function tokenRequest(app: Application, form: Record<string, string>) {
  return request(app).post("/token").type("form").send({ grant_type: JWT_BEARER_GRANT, resource: RESOURCE.href, ...form });
}

async function verifyWithJwks(app: Application, token: string) {
  const jwks = (await request(app).get("/.well-known/jwks.json").expect(200)).body as JSONWebKeySet;
  const { payload, protectedHeader } = await jwtVerify<AccessTokenClaims>(token, createLocalJWKSet(jwks), {
    issuer: ISSUER.href,
    audience: RESOURCE.href,
    algorithms: ["ES256"],
  });
  return { claims: payload, header: protectedHeader };
}

describe("POST /token (jwt-bearer)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("jwt-bearer issues a token with seller scopes for a level-2 seller", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(seller) }).expect(200);

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: ROLE_SCOPES[1]!.join(" ") });
    const { claims, header } = await verifyWithJwks(app, res.body.access_token);
    expect(header.alg).toBe("ES256");
    expect(claims).toMatchObject({
      iss: ISSUER.href,
      sub: seller.uaid,
      agent: seller.address,
      role: 1,
      kya_level: 2,
      owner_group: seller.record.ownerGroup,
      scope: "receivable:write receivable:read credit:read facility:open budget:write spend:reserve stats:read",
    });
  });

  it("level-1 agent gets read scopes only", async () => {
    const { app, kya } = await testApp();
    const worker = newAgent(3, 1, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(worker) }).expect(200);

    expect(res.body.scope).toBe("receivable:read credit:read stats:read");
    const { claims } = await verifyWithJwks(app, res.body.access_token);
    expect(claims.kya_level).toBe(1);
    expect(claims.scope).toBe("receivable:read credit:read stats:read");
  });

  it("revoked agent is rejected with KYA_FAIL", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, { revoked: true }, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(seller) }).expect(400);

    expect(res.body).toMatchObject({ error: "invalid_grant", code: "KYA_FAIL" });
    expect(res.body).not.toHaveProperty("access_token");
  });

  it("expired KYA registration is rejected with KYA_FAIL", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, { expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1) }, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(seller) }).expect(400);
    expect(res.body.code).toBe("KYA_FAIL");
  });

  it("unregistered agent is rejected with KYA_FAIL", async () => {
    const { app } = await testApp();
    const stranger = newAgent(1, 2);

    const res = await tokenRequest(app, { assertion: await assertionFor(stranger) }).expect(400);
    expect(res.body.code).toBe("KYA_FAIL");
  });

  it("mandate hash mismatch is rejected with KYA_FAIL", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(seller, { mandateHash: `0x${"00".repeat(32)}` }) }).expect(400);
    expect(res.body.code).toBe("KYA_FAIL");
  });

  it("level-0 agent is rejected with KYA_LEVEL_TOO_LOW", async () => {
    const { app, kya } = await testApp();
    const buyer = newAgent(2, 0, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(buyer) }).expect(400);
    expect(res.body).toMatchObject({ error: "invalid_grant", code: "KYA_LEVEL_TOO_LOW" });
  });

  it("an assertion sub that is not the agent's registered UAID is rejected with UAID_MISMATCH", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);
    const victim = newAgent(2, 3, {}, kya);
    const assertion = await signAgentAssertion({ privateKey: seller.privateKey, uaid: victim.uaid, audience: ISSUER.href, mandateHash: MANDATE });

    const res = await tokenRequest(app, { assertion }).expect(400);
    expect(res.body).toMatchObject({ error: "invalid_grant", code: "UAID_MISMATCH" });
    expect(res.body).not.toHaveProperty("access_token");
  });

  it("an agent registered with the pre-UAID placeholder hash gets the registry hash as sub, never the asserted UAID", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2);
    const placeholder = keccak256(seller.address);
    kya.set(seller.address, { ...seller.record, uaidHash: placeholder });
    const assertion = await signAgentAssertion({ privateKey: seller.privateKey, uaid: "uaid:aid:anyone", audience: ISSUER.href, mandateHash: MANDATE });

    const res = await tokenRequest(app, { assertion }).expect(200);
    const { claims } = await verifyWithJwks(app, res.body.access_token);
    expect(claims.sub).toBe(placeholder);
    expect(claims.scope).toBe(ROLE_SCOPES[1]!.join(" "));
  });

  it("the configured KYA issuer identity gets agent:admin, and only that scope", async () => {
    const kyaIssuer = newAgent(0, 0);
    const { app } = await testApp({ KYA_ISSUER_EVM: kyaIssuer.address });

    const res = await tokenRequest(app, { assertion: await assertionFor(kyaIssuer) }).expect(200);
    expect(res.body.scope).toBe("agent:admin");
    const { claims } = await verifyWithJwks(app, res.body.access_token);
    expect(claims).toMatchObject({ agent: kyaIssuer.address, role: 0, sub: kyaIssuer.address, scope: "agent:admin" });
  });

  it("no registered agent gets agent:admin through the jwt-bearer grant", async () => {
    const { app, kya } = await testApp({ KYA_ISSUER_EVM: newAgent(0, 0).address });
    for (const role of [1, 2, 3, 4]) {
      const agent = newAgent(role, 3, {}, kya);
      const res = await tokenRequest(app, { assertion: await assertionFor(agent) }).expect(200);
      expect(res.body.scope.split(" ")).not.toContain("agent:admin");
    }
  });

  it("resource mismatch is rejected", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(seller), resource: "http://localhost:9999/other" }).expect(400);

    expect(res.body.error).toBe("invalid_target");
    expect(res.body).not.toHaveProperty("access_token");
  });

  it("jti replay is rejected", async () => {
    const { app, kya } = await testApp();
    const seller = newAgent(1, 2, {}, kya);
    const assertion = await assertionFor(seller);

    await tokenRequest(app, { assertion }).expect(200);
    const replay = await tokenRequest(app, { assertion }).expect(400);

    expect(replay.body.error).toBe("invalid_grant");
    expect(replay.body.error_description).toMatch(/jti/);
  });

  it("access token audience equals MCP_RESOURCE_URL and expires in 600s", async () => {
    const { app, kya } = await testApp();
    const lender = newAgent(4, 2, {}, kya);

    const res = await tokenRequest(app, { assertion: await assertionFor(lender) }).expect(200);

    const { claims, header } = await verifyWithJwks(app, res.body.access_token);
    expect(header.typ).toBe("at+jwt");
    expect(claims.aud).toBe(RESOURCE.href);
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims.scope).toBe("receivable:read credit:read stats:read lend:write");
  });

  it("jti replay is rejected inside the clock-skew window after exp", async () => {
    const kya = new InMemoryKyaReader();
    const seller = newAgent(1, 2, {}, kya);
    const deps = { kya, keys: await tempKeys(), issuer: ISSUER, resource: RESOURCE, jti: new JtiReplayCache() };
    const assertion = await assertionFor(seller);
    const body = { grant_type: JWT_BEARER_GRANT, assertion, resource: RESOURCE.href };
    const { exp } = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as { exp: number };

    await handleJwtBearerGrant(deps, body);
    // Past exp but still accepted by the skew tolerance: the jti must still be remembered.
    vi.spyOn(Date, "now").mockReturnValue((exp + 10) * 1000);
    expect(exp + 10).toBeLessThan(exp + CLOCK_SKEW_SECONDS);
    await expect(handleJwtBearerGrant(deps, body)).rejects.toMatchObject({ code: "invalid_grant", description: expect.stringMatching(/jti/) });
  });

  describe("kya_evidence", () => {
    const skyfireIssuer = "https://skyfire.example";

    async function evidenceSetup() {
      const skyfire = await generateKeyPair("ES256");
      const kya = new InMemoryKyaReader();
      const worker = newAgent(3, 1, {}, kya);
      const deps = {
        kya,
        keys: await tempKeys(),
        issuer: ISSUER,
        resource: RESOURCE,
        jti: new JtiReplayCache(),
        kyaEvidence: {
          issuer: skyfireIssuer,
          keys: createLocalJWKSet({ keys: [{ ...(await exportJWK(skyfire.publicKey)), alg: "ES256" }] }),
        },
      };
      const evidence = (sub: string, signer = skyfire.privateKey) =>
        new SignJWT({ sub })
          .setProtectedHeader({ alg: "ES256", typ: "kya+jwt" })
          .setIssuer(skyfireIssuer)
          .setAudience(ISSUER.href)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(signer);
      const grant = async (kyaEvidence: string) =>
        handleJwtBearerGrant(deps, {
          grant_type: JWT_BEARER_GRANT,
          assertion: await assertionFor(worker, { kyaEvidence }),
          resource: RESOURCE.href,
        });
      return { worker, evidence, grant, kya };
    }

    it("kya_evidence from the configured issuer raises the level to 3", async () => {
      const { worker, evidence, grant } = await evidenceSetup();

      expect((await grant(await evidence(worker.address))).scope).toBe(ROLE_SCOPES[3]!.join(" "));
      expect((await grant(await evidence(worker.address.toLowerCase()))).scope).toBe(ROLE_SCOPES[3]!.join(" "));
      expect((await grant(await evidence(worker.uaid))).scope).toBe(ROLE_SCOPES[3]!.join(" "));
    });

    it("kya_evidence signed by an unknown key is rejected with KYA_FAIL", async () => {
      const { worker, evidence, grant } = await evidenceSetup();
      const forged = await evidence(worker.address, (await generateKeyPair("ES256")).privateKey);

      await expect(grant(forged)).rejects.toMatchObject({ code: "KYA_FAIL" });
    });

    it("kya_evidence is bound to the registered UAID only: a placeholder registration accepts the address alone", async () => {
      const { worker, evidence, grant, kya } = await evidenceSetup();
      kya.set(worker.address, { ...worker.record, uaidHash: keccak256(worker.address) });

      expect((await grant(await evidence(worker.address))).scope).toBe(ROLE_SCOPES[3]!.join(" "));
      await expect(grant(await evidence(worker.uaid))).rejects.toMatchObject({ code: "KYA_FAIL" });
    });

    it("kya_evidence issued for another agent is rejected with KYA_FAIL", async () => {
      const { evidence, grant } = await evidenceSetup();
      const someoneElse = newAgent(3, 2);

      await expect(grant(await evidence(someoneElse.address))).rejects.toMatchObject({
        code: "KYA_FAIL",
        description: expect.stringMatching(/sub/),
      });
      await expect(grant(await evidence(someoneElse.uaid))).rejects.toMatchObject({ code: "KYA_FAIL" });
    });
  });
});
