/**
 * Authorization-code + PKCE path for human-operated MCP clients (D-P8), plugged into the SDK's
 * `mcpAuthRouter` (which validates client_id/redirect_uri and enforces PKCE S256).
 *
 * DEMO ONLY: there is no owner login. `GET /authorize` renders a page listing the agents known to
 * the KYA reader with a "Grant" button each; clicking one issues a code bound to that agent, the
 * requested scopes and the PKCE challenge. `agent:admin` is added only when the page is opened
 * with `?admin=1`. A production AS must authenticate the owner and check they own the agent.
 */
import { randomBytes } from "node:crypto";
import { AGENT_ADMIN_SCOPE, scopesForRole } from "@casheth/shared";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  UnsupportedGrantTypeError,
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

interface PendingCode {
  clientId: string;
  agent: `0x${string}`;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
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

export class CashEthOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();
  private readonly codes = new Map<string, PendingCode>();

  constructor(private readonly deps: ProviderDeps) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.deps.resource.href) {
      throw new InvalidTargetError(`resource must be ${this.deps.resource.href}`);
    }
    const req = res.req;
    const input = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
    const admin = input.admin === "1";

    if (input.grant !== "1") {
      await this.renderGrantPage(client, params, admin, res);
      return;
    }

    if (typeof input.agent !== "string" || !isAddress(input.agent)) throw new InvalidRequestError("agent must be an EVM address");
    const agent = getAddress(input.agent);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const record = await requireKyaAgent(this.deps.kya, agent, { nowSeconds }).catch(kyaToOAuth);

    const allowed = [...scopesForRole(record.role, record.level), ...(admin ? [AGENT_ADMIN_SCOPE] : [])];
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

  private async renderGrantPage(client: OAuthClientInformationFull, params: AuthorizationParams, admin: boolean, res: Response) {
    const hidden: Record<string, string | undefined> = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
      scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
      resource: params.resource?.href,
      admin: admin ? "1" : undefined,
      grant: "1",
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const action = escapeHtml(new URL("/authorize", this.deps.issuer).href);
    const agents = await this.deps.kya.listAgents();
    const rows = agents
      .map(
        (a) =>
          `<li><form method="post" action="${action}">${fields}<input type="hidden" name="agent" value="${a.address}">` +
          `<code>${a.address}</code> ${escapeHtml(ROLE_NAMES[a.role] ?? `role ${a.role}`)} (KYA level ${a.level}) ` +
          `<button type="submit">Grant</button></form></li>`,
      )
      .join("");
    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>CashETH grant</title></head><body>` +
          `<h1>Grant access to ${escapeHtml(client.client_name ?? client.client_id)}</h1>` +
          `<p>Demo only: no owner login. Pick the agent this client will act as${admin ? " (with agent:admin)" : ""}.</p>` +
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

    // Re-check KYA at exchange time: the agent may have been revoked since the grant.
    const record = await requireKyaAgent(this.deps.kya, pending.agent, { nowSeconds }).catch((error: unknown) => {
      if (error instanceof AuthError) throw new InvalidGrantError(`${error.code}: ${error.description}`);
      throw error;
    });
    return mintAccessToken({
      keys: this.deps.keys,
      issuer: this.deps.issuer,
      resource: this.deps.resource,
      sub: record.uaidHash,
      agent: pending.agent,
      record,
      level: record.level,
      scopes: pending.scopes,
      clientId: client.client_id,
    });
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError("refresh tokens are not issued; tokens live 10 minutes");
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
