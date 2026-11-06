import { describe, expect, it } from "vitest";
import request from "supertest";
import { requireRoleAndScope, InsufficientScopeError } from "./auth.js";
import { ISSUER, RESOURCE, testApp } from "./test/fakes.js";
import { post, rpc } from "./test/rpc.js";
import type { Caller } from "./orchestrator/types.js";

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const METADATA_URL = "http://localhost:4030/.well-known/oauth-protected-resource/mcp";

describe("bearer auth on POST /mcp", () => {
  it("unauthenticated POST /mcp returns 401 with WWW-Authenticate resource_metadata", async () => {
    const { app } = await testApp();
    const res = await post(app, LIST);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer /);
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(res.body.error).toBe("invalid_token");
  });

  it("serves RFC 9728 protected resource metadata pointing at the authorization server", async () => {
    const { app } = await testApp();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await request(app).get(path).expect(200);
      expect(res.body).toMatchObject({ resource: RESOURCE.href, authorization_servers: [ISSUER.href] });
      expect(res.body.scopes_supported).toEqual(expect.arrayContaining(["receivable:confirm", "stats:read", "lend:write", "agent:admin"]));
    }
  });

  it("token for another audience is rejected 401", async () => {
    const { app, issuer } = await testApp();
    const token = await issuer.mint({ aud: "https://other.example/mcp" });
    const res = await post(app, LIST, token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("expired token rejected", async () => {
    const { app, issuer } = await testApp();
    const token = await issuer.mint({ expSeconds: -60 });
    const res = await post(app, LIST, token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "invalid_token", error_description: "Token has expired" });
  });

  it("token from another issuer (no trailing-slash href) is rejected 401", async () => {
    const { app, issuer } = await testApp();
    const token = await issuer.mint({ iss: "http://localhost:4020" });
    expect((await post(app, LIST, token)).status).toBe(401);
  });

  it("a valid token reaches the MCP server", async () => {
    const { app, issuer } = await testApp();
    const body = await rpc(app, await issuer.mint(), "tools/list");
    expect(body.result?.tools).toBeDefined();
  });

  it("GET /mcp is not offered by the stateless server", async () => {
    const { app, issuer } = await testApp();
    const res = await request(app).get("/mcp").set("Authorization", `Bearer ${await issuer.mint()}`);
    expect(res.status).toBe(405);
  });
});

describe("requireRoleAndScope", () => {
  const caller = (role: number, scopes: string[]): Caller => ({
    agent: "0x00000000000000000000000000000000000000c1",
    role,
    level: 2,
    ownerGroup: "0x00",
    scopes,
    sub: "uaid:aid:x",
    jti: "j",
  });

  it("passes with the scope and an allowed role", () => {
    expect(() => requireRoleAndScope(caller(2, ["receivable:confirm"]), ["buyer"], "receivable:confirm")).not.toThrow();
    expect(() => requireRoleAndScope(caller(4, ["stats:read"]), "any", "stats:read")).not.toThrow();
  });

  it("rejects a missing scope, then a wrong role, with INSUFFICIENT_SCOPE", () => {
    const missing = (() => {
      try {
        requireRoleAndScope(caller(2, ["receivable:read"]), ["buyer"], "receivable:confirm");
      } catch (e) {
        return e as InsufficientScopeError;
      }
    })();
    expect(missing?.toJSON()).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "receivable:confirm", reason: "scope" });

    const wrongRole = (() => {
      try {
        requireRoleAndScope(caller(1, ["spend:pay"]), ["worker"], "spend:pay");
      } catch (e) {
        return e as InsufficientScopeError;
      }
    })();
    expect(wrongRole?.toJSON()).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "spend:pay", requiredRoles: ["worker"], reason: "role" });
  });
});
