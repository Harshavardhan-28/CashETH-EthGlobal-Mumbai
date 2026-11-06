/**
 * RFC 7523 JWT-bearer grant for agents (BUILD.md section 5.2): agent assertion -> KYA gate ->
 * audience-bound access token for the MCP resource.
 */
import { scopesForRole } from "@casheth/shared";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { mintAccessToken, type TokenResponse } from "./accessToken.js";
import { AuthError, verifyAgentAssertion } from "./assertion.js";
import type { SigningKey } from "./keys.js";
import { type KyaReader, requireKyaAgent } from "./kya.js";

export type { TokenResponse } from "./accessToken.js";

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** KYA level granted for the lifetime of one token when third-party evidence verifies. */
export const EVIDENCE_KYA_LEVEL = 3;

/** Single-use `jti` memory; entries are kept until the assertion's own expiry. */
export class JtiReplayCache {
  private readonly seen = new Map<string, number>();

  /** Records `key`; false when it was already used and has not expired. */
  consume(key: string, expiresAt: number, nowSeconds: number): boolean {
    for (const [k, exp] of this.seen) if (exp < nowSeconds) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
}

export interface KyaEvidenceVerifier {
  /** Expected `iss` of the evidence token (e.g. `SKYFIRE_JWKS_ISSUER`). */
  issuer: string;
  keys: JWTVerifyGetKey;
}

/** Skyfire `kya+jwt` verification against `${issuer}/.well-known/jwks.json`. */
export function skyfireEvidenceVerifier(issuer: string): KyaEvidenceVerifier {
  const base = issuer.replace(/\/+$/, "");
  return { issuer: base, keys: createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`)) };
}

export interface JwtBearerDeps {
  kya: KyaReader;
  keys: SigningKey;
  issuer: URL;
  resource: URL;
  jti: JtiReplayCache;
  /** Present only when `SKYFIRE_JWKS_ISSUER` is configured; evidence is ignored otherwise. */
  kyaEvidence?: KyaEvidenceVerifier;
}

/** Identifiers the agent may use as the assertion `aud`: the issuer (with or without trailing slash) or the token endpoint. */
export function assertionAudiences(issuer: URL): string[] {
  return [...new Set([issuer.href, issuer.href.replace(/\/$/, ""), new URL("/token", issuer).href])];
}

function sameResource(requested: string, resource: URL): boolean {
  try {
    const url = new URL(requested);
    url.hash = "";
    return url.href === resource.href;
  } catch {
    return false;
  }
}

async function verifyEvidence(evidence: string, verifier: KyaEvidenceVerifier, issuer: URL): Promise<void> {
  try {
    await jwtVerify(evidence, verifier.keys, {
      issuer: verifier.issuer,
      audience: assertionAudiences(issuer),
      typ: "kya+jwt",
      requiredClaims: ["exp"],
    });
  } catch (error) {
    throw new AuthError("KYA_FAIL", `kya_evidence did not verify: ${(error as Error).message}`);
  }
}

export async function handleJwtBearerGrant(deps: JwtBearerDeps, body: Record<string, unknown>): Promise<TokenResponse> {
  if (body.grant_type !== JWT_BEARER_GRANT) throw new AuthError("unsupported_grant_type", "expected the jwt-bearer grant");
  const { assertion, resource } = body;
  if (typeof assertion !== "string" || assertion.length === 0) throw new AuthError("invalid_request", "assertion is required");
  if (typeof resource !== "string" || !sameResource(resource, deps.resource)) {
    throw new AuthError("invalid_target", `resource must be ${deps.resource.href}`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = await verifyAgentAssertion(assertion, { audience: assertionAudiences(deps.issuer), now: nowSeconds });
  if (!deps.jti.consume(`${claims.iss}:${claims.jti}`, claims.exp, nowSeconds)) {
    throw new AuthError("invalid_grant", "assertion jti was already used");
  }

  const record = await requireKyaAgent(deps.kya, claims.iss, { nowSeconds, mandateHash: claims.mandateHash });
  let level = record.level;
  if (claims.kya_evidence && deps.kyaEvidence) {
    await verifyEvidence(claims.kya_evidence, deps.kyaEvidence, deps.issuer);
    level = Math.max(level, EVIDENCE_KYA_LEVEL);
  }

  const scopes = scopesForRole(record.role, level);
  if (scopes.length === 0) throw new AuthError("KYA_FAIL", `role ${record.role} has no scopes`);
  return mintAccessToken({
    keys: deps.keys,
    issuer: deps.issuer,
    resource: deps.resource,
    sub: claims.sub,
    agent: claims.iss,
    record,
    level,
    scopes,
  });
}
