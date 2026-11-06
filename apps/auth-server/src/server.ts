/**
 * CashETH OAuth 2.1 authorization server: RFC 7523 JWT-bearer for agents (KYA-checked), auth code
 * + PKCE for human MCP clients (SDK `mcpAuthRouter`), JWKS for the MCP resource server.
 */
import { ALL_SCOPES, type Env } from "@casheth/shared";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { AuthError } from "./assertion.js";
import { handleJwtBearerGrant, JtiReplayCache, JWT_BEARER_GRANT, type KyaEvidenceVerifier, skyfireEvidenceVerifier } from "./jwtBearer.js";
import type { SigningKey } from "./keys.js";
import type { KyaReader } from "./kya.js";
import { CashEthOAuthProvider } from "./provider.js";

export interface AuthAppDeps {
  env: Env;
  kya: KyaReader;
  keys: SigningKey;
  issuer: URL;
  resource: URL;
  /** Overrides the Skyfire verifier derived from `SKYFIRE_JWKS_ISSUER`. */
  kyaEvidence?: KyaEvidenceVerifier;
}

function optionalString(env: Env, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function createAuthApp(deps: AuthAppDeps): express.Application {
  const { kya, keys, issuer, resource } = deps;
  const provider = new CashEthOAuthProvider({ kya, keys, issuer, resource });
  const skyfireIssuer = optionalString(deps.env, "SKYFIRE_JWKS_ISSUER");
  const kyaEvidence = deps.kyaEvidence ?? (skyfireIssuer ? skyfireEvidenceVerifier(skyfireIssuer) : undefined);
  const jti = new JtiReplayCache();

  const jwksUri = new URL("/.well-known/jwks.json", issuer);
  const metadata = {
    ...createOAuthMetadata({ provider, issuerUrl: issuer, scopesSupported: [...ALL_SCOPES] }),
    // No refresh tokens are issued; the agent grant is RFC 7523 JWT-bearer.
    grant_types_supported: ["authorization_code", JWT_BEARER_GRANT],
    jwks_uri: jwksUri.href,
  };

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, issuer: issuer.href, resource: resource.href, kid: keys.kid, kyaEvidence: kyaEvidence?.issuer ?? null });
  });
  app.get(jwksUri.pathname, (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json({ keys: [keys.publicJwk] });
  });
  // Served ahead of the SDK router so the advertised grants match what /token accepts.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(metadata);
  });

  // JWT-bearer is handled here; every other grant falls through to the SDK token handler.
  app.post("/token", express.urlencoded({ extended: false }), async (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== JWT_BEARER_GRANT) {
      next();
      return;
    }
    res.set("Cache-Control", "no-store");
    try {
      res.json(await handleJwtBearerGrant({ kya, keys, issuer, resource, jti, kyaEvidence }, body));
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(error.status).json(error.toResponseObject());
        return;
      }
      console.error("jwt-bearer grant failed", error);
      res.status(500).json({ error: "server_error", error_description: "Internal Server Error" });
    }
  });

  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: [...ALL_SCOPES] }));
  return app;
}
