/**
 * Resource-server side of the MCP authorization spec: access tokens are ES256 JWTs (`typ: at+jwt`) from our
 * authorization server, verified against its JWKS with the exact issuer (`new URL(AUTH_ISSUER).href`, trailing
 * slash included) and this server's resource URL as audience. Tokens are never forwarded anywhere.
 */
import type { AccessTokenClaims } from "@casheth/shared";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { getAddress, isAddress, type Hex } from "viem";
import { ROLE_NAMES } from "./orchestrator/common.js";
import type { Caller } from "./orchestrator/types.js";

export const ACCESS_TOKEN_ALG = "ES256";
export const ACCESS_TOKEN_TYP = "at+jwt";

export type VerifierOptions = {
  issuer: URL;
  resource: URL;
  /** Defaults to the issuer's `/.well-known/jwks.json` (fetched and cached by jose). */
  jwks?: JWTVerifyGetKey;
  jwksUri?: URL;
};

/** `OAuthTokenVerifier` for `requireBearerAuth`; the decoded claims go to `AuthInfo.extra.claims`. */
export function createVerifier({ issuer, resource, jwks, jwksUri }: VerifierOptions): OAuthTokenVerifier {
  const keys = jwks ?? createRemoteJWKSet(jwksUri ?? new URL("/.well-known/jwks.json", issuer));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let claims: AccessTokenClaims & { client_id?: string };
      try {
        ({ payload: claims } = await jwtVerify<AccessTokenClaims & { client_id?: string }>(token, keys, {
          issuer: issuer.href,
          audience: resource.href,
          algorithms: [ACCESS_TOKEN_ALG],
          typ: ACCESS_TOKEN_TYP,
          requiredClaims: ["sub", "jti", "exp", "iat", "agent", "role", "scope"],
        }));
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError("Token has expired");
        if (err instanceof joseErrors.JWTClaimValidationFailed) throw new InvalidTokenError(`Token rejected: ${err.claim} ${err.reason}`);
        if (err instanceof joseErrors.JOSEError) throw new InvalidTokenError("Token signature or format is invalid");
        throw err;
      }
      if (typeof claims.agent !== "string" || !isAddress(claims.agent, { strict: false })) {
        throw new InvalidTokenError("Token has no valid agent claim");
      }
      return {
        token,
        clientId: claims.client_id ?? claims.agent,
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
        expiresAt: claims.exp,
        resource: new URL(String(claims.aud)),
        extra: { claims },
      };
    },
  };
}

/** The caller as the tools see it; keyed on the `agent` claim (the `sub` differs between grant paths). */
export function callerFrom(authInfo: AuthInfo | undefined): Caller {
  const claims = authInfo?.extra?.claims as (AccessTokenClaims & { client_id?: string }) | undefined;
  if (!authInfo || !claims) throw new InvalidTokenError("No verified access token on the request");
  return {
    agent: getAddress(claims.agent),
    role: Number(claims.role),
    level: Number(claims.kya_level ?? 0),
    ownerGroup: (claims.owner_group ?? "0x") as Hex,
    scopes: authInfo.scopes,
    sub: claims.sub,
    jti: claims.jti,
    ...(claims.client_id ? { clientId: claims.client_id } : {}),
  };
}

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

/** Thrown inside a tool when the token lacks the scope or the role; mapped to an `isError` tool result. */
export class InsufficientScopeError extends Error {
  constructor(
    readonly required: string,
    readonly requiredRoles: readonly RoleName[] | "any",
    readonly reason: "scope" | "role",
  ) {
    super(reason === "scope" ? `token lacks scope ${required}` : `tool requires role ${[requiredRoles].flat().join(" or ")}`);
    this.name = "InsufficientScopeError";
  }

  toJSON() {
    return { code: "INSUFFICIENT_SCOPE", required: this.required, requiredRoles: this.requiredRoles, reason: this.reason, message: this.message };
  }
}

/** Checks the caller's scope first, then its role (`"any"` admits every role). */
export function requireRoleAndScope(caller: Caller, roles: readonly RoleName[] | "any", scope: string): void {
  if (!caller.scopes.includes(scope)) throw new InsufficientScopeError(scope, roles, "scope");
  if (roles === "any") return;
  const name = ROLE_NAMES[caller.role as keyof typeof ROLE_NAMES];
  if (!name || !roles.includes(name)) throw new InsufficientScopeError(scope, roles, "role");
}
