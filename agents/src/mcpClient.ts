/**
 * MCP client for CashETH agents (docs/API.md section 1). Authentication follows the MCP authorization flow:
 * discover the protected-resource metadata, follow `authorization_servers[0]`, then trade a KYA-signed agent
 * assertion for an audience-bound access token (RFC 7523 JWT-bearer). The token rides on every MCP request and is
 * replaced once when the server answers 401.
 */
import { randomUUID } from "node:crypto";
import { ROLES, signAgentAssertion } from "@casheth/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodeJwt } from "jose";
import { keccak256, toHex, zeroHash, type Hex } from "viem";

export type AgentRole = "seller" | "buyer" | "worker" | "lender";

const ROLE_IDS: Record<AgentRole, number> = { seller: ROLES.Seller, buyer: ROLES.Buyer, worker: ROLES.Worker, lender: ROLES.Lender };
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEFAULT_MCP_URL = "http://localhost:4030/mcp";
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

type FetchLike = typeof fetch;

export interface AgentClientOptions {
  /** The agent's ECDSA (secp256k1) private key; it signs the assertion. */
  agentKey: Hex;
  uaid: string;
  /** The role the agent is registered with; a token for another role is refused. */
  role: AgentRole;
  /** The registered mandate hash the assertion must carry (`register_agent` defaults it to zero). */
  mandateHash?: Hex;
  /** `MCP_RESOURCE_URL`; defaults to the local MCP server. */
  mcpUrl?: string;
  /** Per tool call, in ms (default 120 s): a tool that writes on-chain waits for the receipt, which the Hashio relay can delay. */
  callTimeoutMs?: number;
  fetch?: FetchLike;
}

/** A tool answered `isError`: `code` is one of the codes in docs/API.md section 5. */
export class ToolCallError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    readonly tool: string,
    details: Record<string, unknown>,
  ) {
    const code = typeof details.code === "string" ? details.code : "INTERNAL";
    super(`${tool} failed with ${code}${typeof details.message === "string" ? `: ${details.message}` : ""}`);
    this.name = "ToolCallError";
    this.code = code;
    this.details = details;
  }
}

/** What the agents need from a client: tests substitute a fake. */
export interface ToolCaller {
  call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>): Promise<T>;
}

/** Key for an operation that is naturally unique (an invoice, a pending receivable): a repeat replays the first result. */
export function idempotencyKey(scope: string, ...parts: string[]): string {
  return `${scope}:${keccak256(toHex(parts.join("|"))).slice(2, 34)}`;
}

/** A key that never replays: only for a call that must run again with the same arguments (prefer `idempotencyKey`). */
export function freshKey(scope: string): string {
  return `${scope}:${randomUUID()}`;
}

type TokenEndpoint = { url: string; issuer: string; resource: string };

async function getJson(fetchImpl: FetchLike, url: string | URL): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${String(url)} failed with HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Protected-resource metadata of the MCP server, then the first authorization server's token endpoint. */
async function discoverTokenEndpoint(fetchImpl: FetchLike, mcpUrl: string): Promise<TokenEndpoint> {
  const resourceMetadata = await getJson(fetchImpl, new URL("/.well-known/oauth-protected-resource", mcpUrl));
  const [authorizationServer] = (resourceMetadata.authorization_servers ?? []) as string[];
  if (!authorizationServer) throw new Error(`${mcpUrl} advertises no authorization server`);
  const metadata = await getJson(fetchImpl, new URL("/.well-known/oauth-authorization-server", authorizationServer));
  return { url: String(metadata.token_endpoint), issuer: String(metadata.issuer), resource: String(resourceMetadata.resource) };
}

export class AgentClient implements ToolCaller {
  readonly #options: AgentClientOptions;
  readonly #fetch: FetchLike;
  readonly #mcpUrl: string;
  #endpoint: Promise<TokenEndpoint> | undefined;
  #token: Promise<string> | undefined;
  #mcp: Promise<Client> | undefined;

  private constructor(options: AgentClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#mcpUrl = options.mcpUrl ?? DEFAULT_MCP_URL;
  }

  /** Nothing is fetched until the first call: the token and the MCP connection are set up lazily. */
  static connect(options: AgentClientOptions): AgentClient {
    return new AgentClient(options);
  }

  async listTools(): Promise<string[]> {
    return (await this.listToolDefinitions()).map((tool) => tool.name);
  }

  /** `tools/list` with descriptions and input schemas (what an LLM agent is shown). */
  async listToolDefinitions(): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]> {
    const { tools } = await (await this.#connection()).listTools();
    return tools.map(({ name, description, inputSchema }) => ({ name, ...(description ? { description } : {}), inputSchema }));
  }

  /** Calls a tool and returns its JSON result; an `isError` result throws a `ToolCallError`. */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await (await this.#connection()).callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: this.#options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
    );
    const [first] = result.content as { type: string; text: string }[];
    const body = JSON.parse(first?.text ?? "null") as unknown;
    if (result.isError) throw new ToolCallError(tool, body as Record<string, unknown>);
    return body as T;
  }

  async close(): Promise<void> {
    await (await this.#mcp)?.close();
    this.#mcp = undefined;
  }

  #connection(): Promise<Client> {
    this.#mcp ??= this.#openConnection();
    return this.#mcp;
  }

  async #openConnection(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.#mcpUrl), { fetch: this.#authorizedFetch });
    const client = new Client({ name: `casheth-${this.#options.role}-agent`, version: "0.1.0" });
    await client.connect(transport);
    return client;
  }

  /** Adds the bearer token; on 401 drops it, gets a new one and retries the request once. */
  readonly #authorizedFetch: FetchLike = async (input, init) => {
    const send = async () => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${await this.#accessToken()}`);
      return this.#fetch(input, { ...init, headers });
    };
    const response = await send();
    if (response.status !== 401) return response;
    this.#token = undefined;
    return send();
  };

  #accessToken(): Promise<string> {
    this.#token ??= this.#requestToken().catch((error: unknown) => {
      this.#token = undefined;
      throw error;
    });
    return this.#token;
  }

  async #requestToken(): Promise<string> {
    const { agentKey, uaid, mandateHash = zeroHash, role } = this.#options;
    this.#endpoint ??= discoverTokenEndpoint(this.#fetch, this.#mcpUrl);
    const endpoint = await this.#endpoint;
    const assertion = await signAgentAssertion({ privateKey: agentKey, uaid, audience: endpoint.issuer, mandateHash });
    const res = await this.#fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion, resource: endpoint.resource }),
    });
    const body = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`token request failed (HTTP ${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`);
    }
    const tokenRole = decodeJwt(body.access_token).role;
    if (tokenRole !== ROLE_IDS[role]) throw new Error(`agent is registered with role ${String(tokenRole)}, not ${role}`);
    return body.access_token;
  }
}
