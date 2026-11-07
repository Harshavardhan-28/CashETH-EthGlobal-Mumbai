/**
 * Authorization-code + PKCE path for human-operated MCP clients such as Claude Code (D-P8), plugged into the SDK's
 * `mcpAuthRouter` (dynamic client registration, client_id/redirect_uri validation, PKCE S256). Served only with
 * `AUTH_DEMO_GRANT=true`.
 *
 * DEMO ONLY: there is no owner login. `GET /authorize` renders a seller approval card (`consentPage.ts`): Claude Code
 * signs in as the seller agent, so only sellers known to the KYA reader can be granted. Approving issues a code bound
 * to that seller, the requested scopes (filtered to its role and KYA level, never `agent:admin`) and the PKCE
 * challenge; Cancel returns `access_denied`. The code exchange also returns a
 * rotating refresh token. A production AS must authenticate the owner and check they own the agent.
 */
import { randomBytes } from "node:crypto";
import { scopesForRole } from "@casheth/shared";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { getAddress, isAddress } from "viem";
import { mintAccessToken, verifyAccessTokenJwt } from "./accessToken.js";
import { consentPage, SELLER_ROLE } from "./consentPage.js";
import { AuthError } from "./assertion.js";
import type { SigningKey } from "./keys.js";
import { type KyaReader, requireKyaAgent } from "./kya.js";

const CODE_TTL_SECONDS = 300;
/** A demo session lasts a working day; each refresh rotates the token. */
const REFRESH_TTL_SECONDS = 8 * 3600;

interface PendingCode {
  clientId: string;
  agent: `0x${string}`;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  agent: `0x${string}`;
  scopes: string[];
  expiresAt: number;
}

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    // The SDK's registration handler generates client_id before calling the store.
    const full = client as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    return full;
  }
}

export interface ProviderDeps {
  kya: KyaReader;
  keys: SigningKey;
  issuer: URL;
  resource: URL;
}

function kyaToOAuth(error: unknown): never {
  if (error instanceof AuthError) throw new AccessDeniedError(`${error.code}: ${error.description}`);
  throw error;
}

function kyaToInvalidGrant(error: unknown): never {
  if (error instanceof AuthError) throw new InvalidGrantError(`${error.code}: ${error.description}`);
  throw error;
}

export class CashEthOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, RefreshGrant>();

  constructor(private readonly deps: ProviderDeps) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.deps.resource.href) {
      throw new InvalidTargetError(`resource must be ${this.deps.resource.href}`);
    }
    const req = res.req;
    const input = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;

    if (input.grant === "0") throw new AccessDeniedError("the sign-in was cancelled");
    if (input.grant !== "1") {
      await this.renderGrantPage(client, params, res);
      return;
    }

    if (typeof input.agent !== "string" || !isAddress(input.agent)) throw new InvalidRequestError("agent must be an EVM address");
    const agent = getAddress(input.agent);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const record = await requireKyaAgent(this.deps.kya, agent, { nowSeconds }).catch(kyaToOAuth);
    if (record.role !== SELLER_ROLE) throw new AccessDeniedError("the demo sign-in grants the seller agent only");

    const allowed = scopesForRole(record.role, record.level);
    const requested = params.scopes ?? [];
    const scopes = requested.length > 0 ? allowed.filter((s) => requested.includes(s)) : allowed;
    if (scopes.length === 0) throw new InvalidScopeError("none of the requested scopes can be granted to this agent");

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: client.client_id,
      agent,
      scopes,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      expiresAt: nowSeconds + CODE_TTL_SECONDS,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  }

  /** The seller approval card; only sellers can be granted, since Claude Code always signs in as the seller. */
  private async renderGrantPage(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const fields: Record<string, string | undefined> = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
      scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
      resource: params.resource?.href,
    };
    const sellers = (await this.deps.kya.listAgents()).filter((a) => a.role === SELLER_ROLE);
    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
      .send(
        consentPage({
          clientName: client.client_name ?? client.client_id,
          action: new URL("/authorize", this.deps.issuer).href,
          fields: Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          sellers,
          requested: params.scopes ?? [],
        }),
      );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError("invalid authorization code");
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError("invalid authorization code");
    this.codes.delete(authorizationCode);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (pending.expiresAt < nowSeconds) throw new InvalidGrantError("authorization code expired");
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && resource.href !== this.deps.resource.href) throw new InvalidTargetError(`resource must be ${this.deps.resource.href}`);

    return this.issueTokens(client, { agent: pending.agent, scopes: pending.scopes }, nowSeconds);
  }

  /** Rotates the refresh token: the presented one is spent, a new one comes with the new access token. */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const grant = this.refreshTokens.get(refreshToken);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    if (resource && resource.href !== this.deps.resource.href) throw new InvalidTargetError(`resource must be ${this.deps.resource.href}`);
    if (scopes?.some((s) => !grant.scopes.includes(s))) throw new InvalidScopeError("a refresh cannot add scopes");
    this.refreshTokens.delete(refreshToken);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (grant.expiresAt < nowSeconds) throw new InvalidGrantError("refresh token expired");
    return this.issueTokens(client, { agent: grant.agent, scopes: scopes ?? grant.scopes }, nowSeconds);
  }

  /**
   * Access token plus a fresh refresh token. KYA is re-checked every time (the agent may have been revoked or
   * downgraded since the grant), and the scopes are cut to what its role and level allow now.
   */
  private async issueTokens(client: OAuthClientInformationFull, grant: { agent: `0x${string}`; scopes: string[] }, nowSeconds: number): Promise<OAuthTokens> {
    const record = await requireKyaAgent(this.deps.kya, grant.agent, { nowSeconds }).catch(kyaToInvalidGrant);
    const allowed = scopesForRole(record.role, record.level);
    const scopes = grant.scopes.filter((s) => allowed.includes(s));
    if (scopes.length === 0) throw new InvalidGrantError("the agent no longer holds any of the granted scopes");
    const tokens = await mintAccessToken({
      keys: this.deps.keys,
      issuer: this.deps.issuer,
      resource: this.deps.resource,
      sub: record.uaidHash,
      agent: grant.agent,
      record,
      level: record.level,
      scopes,
      clientId: client.client_id,
    });
    const refreshToken = randomBytes(32).toString("base64url");
    this.refreshTokens.set(refreshToken, { clientId: client.client_id, agent: grant.agent, scopes, expiresAt: nowSeconds + REFRESH_TTL_SECONDS });
    return { ...tokens, refresh_token: refreshToken };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: Awaited<ReturnType<typeof verifyAccessTokenJwt>>;
    try {
      claims = await verifyAccessTokenJwt(token, this.deps);
    } catch (error) {
      throw new InvalidTokenError(`invalid access token: ${(error as Error).message}`);
    }
    return {
      token,
      clientId: claims.client_id ?? claims.agent,
      scopes: claims.scope.split(" ").filter(Boolean),
      expiresAt: claims.exp,
      resource: new URL(claims.aud),
      extra: { ...claims },
    };
  }
}
