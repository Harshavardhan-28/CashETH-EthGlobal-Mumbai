/**
 * The demo authorization-code grant as Claude Code uses it for a remote MCP server: the MCP SDK's own OAuth client
 * (protected-resource metadata, AS metadata, dynamic registration, PKCE S256, refresh token) against the real
 * authorization server and MCP app, with the consent page "clicked" over HTTP.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Stack, startStack } from "./test/stack.js";

const WORKER_SCOPES = ["receivable:read", "credit:read", "spend:reserve", "spend:pay", "spend:commit", "stats:read"];

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

/** Opens the consent page, submits the "Act as <role>" form and returns the code from the redirect. */
async function consent(authorizationUrl: URL, role: string): Promise<string> {
  const page = await (await fetch(authorizationUrl)).text();
  const form = page.split("<form").find((f) => f.includes(`Act as ${role}<`));
  if (!form) throw new Error(`no "Act as ${role}" choice on the consent page`);
  const action = /action="([^"]+)"/.exec(form)![1]!;
  const fields = new URLSearchParams([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replaceAll("&amp;", "&")]));
  const res = await fetch(action, { method: "POST", body: fields, redirect: "manual" });
  const location = new URL(res.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe("claude-code-state");
  return location.searchParams.get("code")!;
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

  it("registers, authorizes with PKCE as the worker, exchanges the code and lists the tools", async () => {
    stack = await startStack({ authEnv: { AUTH_DEMO_GRANT: "true" } });
    const worker = stack.registerAgent(3);
    stack.registerAgent(1);
    const provider = new ClaudeCodeLikeProvider();

    // First contact: 401 -> metadata discovery -> dynamic registration -> browser redirect.
    await expect(connect(stack, provider)).rejects.toBeInstanceOf(UnauthorizedError);
    const url = provider.authorizationUrl!;
    expect(provider.clientInformation()?.client_id).toEqual(expect.any(String));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(stack.mcpUrl);
    expect(url.searchParams.get("scope")).toContain("agent:admin"); // the client asks for every advertised scope...

    const code = await consent(url, "worker");
    const pending = new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { authProvider: provider });
    await pending.finishAuth(code);
    const tokens = provider.tokens()!;
    expect(tokens.scope!.split(" ").sort()).toEqual([...WORKER_SCOPES].sort()); // ...and gets the worker's, never admin
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const { client } = await connect(stack, provider);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["reserve_spend", "pay_x402", "commit_spend", "release_spend"]));
    const admin = await client.callTool({
      name: "register_agent",
      arguments: { account: worker.address, accountId: "0.0.1234", name: "x", role: "worker", level: 3, ownerGroup: "x", idempotencyKey: "claude-code-admin" },
    });
    expect(JSON.parse((admin.content as { text: string }[])[0]!.text)).toMatchObject({ code: "INSUFFICIENT_SCOPE", required: "agent:admin" });
    await client.close();

    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()) as { agent: string; role: number };
    expect(claims).toMatchObject({ agent: worker.address, role: 3 });
  });

  it("gets no authorization-code grant while AUTH_DEMO_GRANT is off", async () => {
    stack = await startStack();
    stack.registerAgent(3);
    await expect(connect(stack, new ClaudeCodeLikeProvider())).rejects.toThrow();
  });
});
