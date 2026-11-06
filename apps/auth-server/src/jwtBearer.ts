/**
 * RFC 7523 JWT-bearer grant for agents (BUILD.md section 5.2): agent assertion -> KYA gate ->
 * audience-bound access token for the MCP resource.
 */
import { AGENT_ADMIN_SCOPE, scopesForRole } from "@casheth/shared";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { keccak256, toHex, zeroHash } from "viem";
import { mintAccessToken, type TokenResponse } from "./accessToken.js";
import { AuthError, CLOCK_SKEW_SECONDS, verifyAgentAssertion } from "./assertion.js";
import type { SigningKey } from "./keys.js";
import { type AgentRecord, type KyaReader, requireKyaAgent } from "./kya.js";

export type { TokenResponse } from "./accessToken.js";

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** KYA level granted for the lifetime of one token when third-party evidence verifies. */
export const EVIDENCE_KYA_LEVEL = 3;

/**
 * Single-use `jti` memory. Callers pass the last second at which the assertion can still verify
 * (`exp + CLOCK_SKEW_SECONDS`), so an entry outlives every window in which a replay could pass.
 */
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
  /** `KYA_ISSUER_EVM`: the registry's issuer, the only identity that is granted `agent:admin`. */
  adminAgent?: `0x${string}`;
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

/** Signature algorithms accepted for KYA evidence (Skyfire signs `kya+jwt` with ES256). */
export const KYA_EVIDENCE_ALGORITHMS = ["ES256"];

/**
 * The asserted UAID when `KYARegistry` holds its hash for the agent. Agents registered before UAIDs existed hold
 * the placeholder `keccak256(address)` (scripts/c2-register-demo.ts, c4-register.ts): their UAID cannot be checked,
 * so it is not used at all (undefined). Any other hash means the assertion names someone else's UAID.
 */
export function registeredUaid(address: `0x${string}`, sub: string, record: AgentRecord): string | undefined {
  const registered = record.uaidHash.toLowerCase();
  if (keccak256(toHex(sub)) === registered) return sub;
  if (keccak256(address) === registered) return undefined;
  throw new AuthError("UAID_MISMATCH", `assertion sub ${sub} is not the UAID registered for ${address}`);
}

/**
 * Verifies third-party KYA evidence and binds it to the presenting agent: the evidence `sub` must be
 * either the agent's EVM address (`iss` of the assertion, compared case-insensitively) or its registered
 * UAID. Evidence issued for anyone else is rejected.
 */
async function verifyEvidence(
  evidence: string,
  verifier: KyaEvidenceVerifier,
  issuer: URL,
  agent: { address: `0x${string}`; uaid?: string },
): Promise<void> {
  let sub: unknown;
  try {
    ({
      payload: { sub },
    } = await jwtVerify(evidence, verifier.keys, {
      issuer: verifier.issuer,
      audience: assertionAudiences(issuer),
      algorithms: KYA_EVIDENCE_ALGORITHMS,
      typ: "kya+jwt",
      requiredClaims: ["exp", "sub"],
    }));
  } catch (error) {
    throw new AuthError("KYA_FAIL", `kya_evidence did not verify: ${(error as Error).message}`);
  }
  const boundToAgent =
    typeof sub === "string" && (sub.toLowerCase() === agent.address.toLowerCase() || (agent.uaid !== undefined && sub === agent.uaid));
  if (!boundToAgent) throw new AuthError("KYA_FAIL", "kya_evidence sub is not the presenting agent's address or UAID");
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
  if (!deps.jti.consume(`${claims.iss}:${claims.jti}`, claims.exp + CLOCK_SKEW_SECONDS, nowSeconds)) {
    throw new AuthError("invalid_grant", "assertion jti was already used");
  }

  if (deps.adminAgent !== undefined && claims.iss === deps.adminAgent) return mintAdminToken(deps, claims.iss);

  const record = await requireKyaAgent(deps.kya, claims.iss, { nowSeconds, mandateHash: claims.mandateHash });
  const uaid = registeredUaid(claims.iss, claims.sub, record);
  let level = record.level;
  if (claims.kya_evidence && deps.kyaEvidence) {
    await verifyEvidence(claims.kya_evidence, deps.kyaEvidence, deps.issuer, { address: claims.iss, uaid });
    level = Math.max(level, EVIDENCE_KYA_LEVEL);
  }

  const scopes = scopesForRole(record.role, level);
  if (scopes.length === 0) throw new AuthError("KYA_FAIL", `role ${record.role} has no scopes`);
  return mintAccessToken({
    keys: deps.keys,
    issuer: deps.issuer,
    resource: deps.resource,
    sub: uaid ?? record.uaidHash,
    agent: claims.iss,
    record,
    level,
    scopes,
  });
}

/**
 * `agent:admin` alone for the KYA issuer key, which may write `KYARegistry` directly anyway. It is not a registered
 * agent: role and level are 0 and `sub` is its address (never a self-asserted UAID).
 */
function mintAdminToken(deps: JwtBearerDeps, issuerAddress: `0x${string}`): Promise<TokenResponse> {
  const record: AgentRecord = { uaidHash: zeroHash, ownerGroup: zeroHash, role: 0, level: 0, expiresAt: 0n, revoked: false, mandateHash: zeroHash };
  return mintAccessToken({
    keys: deps.keys,
    issuer: deps.issuer,
    resource: deps.resource,
    sub: issuerAddress,
    agent: issuerAddress,
    record,
    level: 0,
    scopes: [AGENT_ADMIN_SCOPE],
  });
}
