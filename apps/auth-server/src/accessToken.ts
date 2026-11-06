/** Access tokens (RFC 9068 shape): ES256 JWT, `typ: at+jwt`, audience = MCP resource, 10 minutes. */
import { randomUUID } from "node:crypto";
import type { AccessTokenClaims } from "@casheth/shared";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { ACCESS_TOKEN_ALG, type SigningKey } from "./keys.js";
import type { AgentRecord } from "./kya.js";

export const ACCESS_TOKEN_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TYP = "at+jwt";

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface MintInput {
  keys: SigningKey;
  issuer: URL;
  resource: URL;
  sub: string;
  agent: `0x${string}`;
  record: AgentRecord;
  /** KYA level for this token (may be raised above the registry level by verified evidence). */
  level: number;
  scopes: string[];
  /** OAuth client that obtained the token (auth-code path only). */
  clientId?: string;
}

export async function mintAccessToken(input: MintInput): Promise<TokenResponse> {
  const scope = input.scopes.join(" ");
  const claims: Omit<AccessTokenClaims, "iss" | "sub" | "aud" | "jti" | "exp" | "iat"> & { client_id?: string } = {
    agent: input.agent,
    role: input.record.role,
    kya_level: input.level,
    owner_group: input.record.ownerGroup,
    scope,
    ...(input.clientId ? { client_id: input.clientId } : {}),
  };
  const iat = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALG, typ: ACCESS_TOKEN_TYP, kid: input.keys.kid })
    .setIssuer(input.issuer.href)
    .setSubject(input.sub)
    .setAudience(input.resource.href)
    .setJti(randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(input.keys.privateKey);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, scope };
}

export async function verifyAccessTokenJwt(
  token: string,
  { keys, issuer, resource }: { keys: SigningKey; issuer: URL; resource: URL },
): Promise<AccessTokenClaims & { client_id?: string }> {
  const publicKey = await importJWK(keys.publicJwk, ACCESS_TOKEN_ALG);
  const { payload } = await jwtVerify<AccessTokenClaims & { client_id?: string }>(token, publicKey, {
    issuer: issuer.href,
    audience: resource.href,
    algorithms: [ACCESS_TOKEN_ALG],
    typ: ACCESS_TOKEN_TYP,
    requiredClaims: ["sub", "jti", "exp", "iat", "agent", "scope"],
  });
  return payload;
}
