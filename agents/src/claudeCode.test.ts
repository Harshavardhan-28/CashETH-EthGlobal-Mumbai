/**
 * The demo authorization-code grant as Claude Code uses it for a remote MCP server: the MCP SDK's own OAuth client
 * (protected-resource metadata, AS metadata, dynamic registration, PKCE S256, refresh token) against the real
 * authorization server and MCP app, with the consent page "clicked" over HTTP.
 */
import { readFileSync } from "node:fs";
import { ROLE_SCOPES } from "@casheth/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Stack, startStack } from "./test/stack.js";


/** The repo's `.mcp.json`: Claude Code signs in once, as the seller (the main agent); the buyer and worker are server-run counterparties. */
const MCP_JSON = JSON.parse(readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8")) as {
  mcpServers: Record<string, { type: string; url?: string; oauth?: { scopes?: string } }>;
};

describe(".mcp.json", () => {
  it("declares one CashETH server, casheth-seller, pinned to exactly the seller's scopes", () => {
    expect(Object.keys(MCP_JSON.mcpServers)).toEqual(["casheth-seller"]);
    const seller = MCP_JSON.mcpServers["casheth-seller"]!;
    expect(seller).toMatchObject({ type: "http", url: "http://localhost:4030/mcp" });
    expect(seller.oauth?.scopes?.split(" ").sort()).toEqual([...ROLE_SCOPES[1]!].sort());
  });

  it("gives CashETH tools ten minutes: buy_with_credit sends two Hedera transactions and an x402 settlement", () => {
    expect((MCP_JSON.mcpServers["casheth-seller"] as { timeout?: number }).timeout).toBe(600_000);
  });
});

/** In-memory stand-in for Claude Code's OAuth provider; the "browser" is the test. */
class ClaudeCodeLikeProvider implements OAuthClientProvider {
  readonly redirectUrl = "http://localhost:53682/callback";
  authorizationUrl: URL | undefined;
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier = "";

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Claude Code (casheth)",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return "claude-code-state";
  }
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.#client = info;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

/** Opens the consent page, approves the preselected seller and returns the code from the redirect. */
async function approve(authorizationUrl: URL): Promise<{ code: string; page: string }> {
  const page = await (await fetch(authorizationUrl)).text();
  const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
  if (!action) throw new Error("no approval form on the consent page");
  const fields = new URLSearchParams([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replaceAll("&amp;", "&")]));
  fields.set("agent", /type="radio" name="agent" value="([^"]+)" checked/.exec(page)![1]!);
  fields.set("grant", "1"); // the Approve button
  const res = await fetch(action.replaceAll("&amp;", "&"), { method: "POST", body: fields, redirect: "manual" });
  const location = new URL(res.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe("claude-code-state");
  return { code: location.searchParams.get("code")!, page };
}

async function connect(stack: Stack, provider: OAuthClientProvider) {
  const client = new Client({ name: "claude-code", version: "test" });
  const transport = new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider });
  await client.connect(transport);
  return { client, transport };
}

describe("Claude Code as a remote MCP client (AUTH_DEMO_GRANT=true)", () => {
  let stack: Stack;
  afterEach(async () => stack?.stop());

  it("registers, approves the seller with PKCE, exchanges the code and lists the seller's tools", async () => {
    stack = await startStack({ authEnv: { AUTH_DEMO_GRANT: "true" } });
    const seller = stack.registerAgent(1);
    const buyer = stack.registerAgent(2, 3);
    stack.registerAgent(3);
    const provider = new ClaudeCodeLikeProvider();

    // First contact: 401 -> metadata discovery -> dynamic registration -> browser redirect.
    await expect(connect(stack, provider)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = provider.authorizationUrl!;
    expect(provider.clientInformation()?.client_id).toEqual(expect.any(String));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(stack.mcpUrl);
    expect(url.searchParams.get("scope")).toContain("agent:admin"); // the client asks for every advertised scope...

    const { code, page } = await approve(url);
    expect(page).toContain(seller.address);
    expect(page).not.toContain(buyer.address); // only the seller is offered
    const pending = new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider });
    await pending.finishAuth(code);
    const tokens = provider.tokens()!;
    expect(tokens.scope!.split(" ").sort()).toEqual([...ROLE_SCOPES[1]!].sort()); // ...and gets the seller's, never admin
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const { client } = await connect(stack, provider);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["upload_receivable", "open_facility", "buy_with_credit", "settle_receivable"]));
    const admin = await client.callTool({
      name: "register_agent",
      arguments: { account: seller.address, accountId: "0.0.1234", name: "x", role: "seller", level: 3, ownerGroup: "x", idempotencyKey: "claude-code-admin" },
    });
    expect(JSON.parse((admin.content as { text: string }[])[0]!.text)).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "agent:admin" });
    await client.close();

    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()) as { agent: string; role: number };
    expect(claims).toMatchObject({ agent: seller.address, role: 1 });
  });

  it("grants exactly the scopes .mcp.json pins for casheth-seller", async () => {
    stack = await startStack({ authEnv: { AUTH_DEMO_GRANT: "true" } });
    stack.registerAgent(1);
    const provider = new ClaudeCodeLikeProvider();
    await expect(connect(stack, provider)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = new URL(provider.authorizationUrl!);
    url.searchParams.set("scope", ROLE_SCOPES[1]!.join(" "));

    await new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider }).finishAuth((await approve(url)).code);
    expect(provider.tokens()!.scope!.split(" ").sort()).toEqual([...ROLE_SCOPES[1]!].sort());
  });

  it("gets no authorization-code grant while AUTH_DEMO_GRANT is off", async () => {
    stack = await startStack();
    stack.registerAgent(3);
    await expect(connect(stack, new ClaudeCodeLikeProvider())).rejects.toThrow();
  });
});
