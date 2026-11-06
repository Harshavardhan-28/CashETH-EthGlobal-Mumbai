/**
 * Test-only: the real authorization server and the real MCP app on ephemeral localhost ports, backed by the
 * MCP server's fake orchestrator (excluded from the build). Agents authenticate against it exactly as in production.
 */
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InMemoryKyaReader } from "../../../apps/auth-server/src/kya.js";
import { createAuthApp } from "../../../apps/auth-server/src/server.js";
import { newAgent, tempKeys, testEnv, type TestAgent } from "../../../apps/auth-server/src/test/fixtures.js";
import { createVerifier } from "../../../apps/mcp-server/src/auth.js";
import { createMcpApp } from "../../../apps/mcp-server/src/server.js";
import { fakeOrchestrator, type TestOrchestrator } from "../../../apps/mcp-server/src/test/fakes.js";

export { ADDRS, budget, kyaAgent, NOW } from "../../../apps/mcp-server/src/test/fakes.js";
export type { TestAgent, TestOrchestrator };

/** A listening server whose request handler is attached once the app (which needs the port-derived URL) exists. */
async function listen(): Promise<{ server: Server; url: URL; serve: (handler: RequestListener) => void }> {
  let handler: RequestListener = (_req, res) => void res.writeHead(503).end();
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: new URL(`http://localhost:${port}`), serve: (h) => (handler = h) };
}

export interface Stack {
  mcpUrl: string;
  orchestrator: TestOrchestrator;
  /** A fresh agent key registered in the KYA registry with `role` at `level`. */
  registerAgent(role: number, level?: number): TestAgent;
  /** Number of `POST /token` requests the authorization server has received. */
  tokenRequests(): number;
  stop(): Promise<void>;
}

export interface StackOptions {
  /** Extra authorization-server environment, e.g. `{ AUTH_DEMO_GRANT: "true" }`. */
  authEnv?: Record<string, string>;
}

export async function startStack({ authEnv = {} }: StackOptions = {}): Promise<Stack> {
  const kya = new InMemoryKyaReader();
  const keys = await tempKeys();
  const [auth, mcp] = await Promise.all([listen(), listen()]);
  const resource = new URL("/mcp", mcp.url);
  let tokenRequests = 0;

  const authApp = createAuthApp({ env: testEnv(authEnv), kya, keys, issuer: auth.url, resource });
  auth.serve((req, res) => {
    if (req.method === "POST" && req.url === "/token") tokenRequests += 1;
    authApp(req, res);
  });

  const metadataUrl = new URL("/.well-known/oauth-authorization-server", auth.url);
  const oauthMetadata = (await (await fetch(metadataUrl)).json()) as OAuthMetadata;
  const orchestrator = fakeOrchestrator();
  mcp.serve(
    createMcpApp({
      orchestrator,
      resource,
      oauthMetadata,
      verifier: createVerifier({ issuer: auth.url, resource }),
      corsOrigins: [],
    }),
  );

  const close = (s: Server) => new Promise<void>((resolve) => void s.close(() => resolve()));
  return {
    mcpUrl: resource.href,
    orchestrator,
    registerAgent: (role, level = 2) => newAgent(role, level, {}, kya),
    tokenRequests: () => tokenRequests,
    stop: async () => void (await Promise.all([close(auth.server), close(mcp.server)])),
  };
}
