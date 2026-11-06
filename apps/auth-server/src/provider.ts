/**
 * Authorization-code + PKCE path for human-operated MCP clients such as Claude Code (D-P8), plugged into the SDK's
 * `mcpAuthRouter` (dynamic client registration, client_id/redirect_uri validation, PKCE S256). Served only with
 * `AUTH_DEMO_GRANT=true`.
 *
 * DEMO ONLY: there is no owner login. `GET /authorize` renders a consent page with one "Act as <role>" choice per
 * agent known to the KYA reader; choosing one issues a code bound to that agent, the requested scopes (filtered to
 * the agent's role and KYA level, never `agent:admin`) and the PKCE challenge. The code exchange also returns a
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

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ROLE_NAMES: Record<number, string> = { 1: "seller", 2: "buyer", 3: "worker", 4: "lender" };

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

    if (input.grant !== "1") {
      await this.renderGrantPage(client, params, res);
      return;
    }

    if (typeof input.agent !== "string" || !isAddress(input.agent)) throw new InvalidRequestError("agent must be an EVM address");
    const agent = getAddress(input.agent);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const record = await requireKyaAgent(this.deps.kya, agent, { nowSeconds }).catch(kyaToOAuth);

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

  private async renderGrantPage(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const hidden: Record<string, string | undefined> = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
      scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
      resource: params.resource?.href,
      grant: "1",
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const action = escapeHtml(new URL("/authorize", this.deps.issuer).href);
    const agents = (await this.deps.kya.listAgents()).filter((a) => ROLE_NAMES[a.role] !== undefined).sort((x, y) => x.role - y.role);
    // A client that pins its scopes (Claude Code `oauth.scopes`, one MCP server name per role) names its role through
    // them: the agents that can hold every requested scope come first and the first one has the focus.
    const requested = params.scopes ?? [];
    const covers = (a: (typeof agents)[number]) => {
      const allowed = scopesForRole(a.role, a.level);
      return requested.length > 0 && requested.every((s) => allowed.includes(s));
    };
    const row = (a: (typeof agents)[number], focus: boolean) =>
      `<li><form method="post" action="${action}">${fields}<input type="hidden" name="agent" value="${a.address}">` +
      `<button type="submit"${focus ? " autofocus" : ""}>Act as ${ROLE_NAMES[a.role]}</button> <code>${a.address}</code> (KYA level ${a.level}: ` +
      `${escapeHtml(scopesForRole(a.role, a.level).join(" ") || "no scopes")})</form></li>`;
    const matching = agents.filter(covers);
    const others = agents.filter((a) => !covers(a));
    const rows = matching.length
      ? `<li><strong>Matches the requested scopes</strong><ul>${matching.map((a, i) => row(a, i === 0)).join("")}</ul></li>` +
        (others.length ? `<li>Other demo agents<ul>${others.map((a) => row(a, false)).join("")}</ul></li>` : "")
      : agents.map((a) => row(a, false)).join("");
    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>CashETH grant</title></head><body>` +
          `<h1>Grant access to ${escapeHtml(client.client_name ?? client.client_id)}</h1>` +
          `<p>Demo only: no owner login. Pick the demo role this client will act as; its token carries that agent's scopes.</p>` +
          `<ul>${rows || "<li>No registered agents.</li>"}</ul></body></html>`,
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
