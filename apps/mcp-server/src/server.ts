/**
 * CashETH MCP server: an OAuth 2.1 resource server (RFC 9728 metadata, audience-bound bearer tokens) exposing the
 * CashETH tools over stateless Streamable HTTP, plus the unauthenticated read API for the dashboard (Ruling R14):
 * `GET /events`, `GET /agents`, `GET /lenders`, `GET /receivables/:id`, `GET /invoices/:keccak`, `GET /health`.
 */
import { ALL_SCOPES } from "@casheth/shared";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { jsonSafe } from "./orchestrator/audit.js";
import { bytes32 } from "./orchestrator/common.js";
import { ToolError } from "./orchestrator/errors.js";
import { receivableDetails } from "./orchestrator/receivables.js";
import type { Orchestrator } from "./orchestrator/types.js";
import { registerTools } from "./tools.js";

export { createVerifier, callerFrom, requireRoleAndScope, InsufficientScopeError } from "./auth.js";
export { registerTools } from "./tools.js";
export type * from "./orchestrator/types.js";

export const SERVER_INFO = { name: "casheth-mcp", version: "0.1.0" } as const;

export interface McpAppDeps {
  orchestrator: Orchestrator;
  /** `MCP_RESOURCE_URL`: the token audience and the path `POST` is served on. */
  resource: URL;
  /** The authorization server's RFC 8414 metadata (fetched from `AUTH_ISSUER` at boot). */
  oauthMetadata: OAuthMetadata;
  verifier: OAuthTokenVerifier;
  /** Origins allowed to read the read API from a browser (`*` allows any). */
  corsOrigins: string[];
}

/** A fresh MCP server with every tool registered (one per request: the transport is stateless). */
export function createMcpServer(o: Orchestrator): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, o);
  return server;
}

function cors(origins: string[]) {
  const any = origins.includes("*");
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && (any || origins.includes(origin))) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function sendError(res: Response, err: unknown, o: Orchestrator): void {
  if (err instanceof ToolError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "BAD_INPUT" ? 400 : err.code === "NOT_DEPLOYED" ? 503 : 500;
    res.status(status).json(err.toJSON());
    return;
  }
  o.log("read api error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ code: "INTERNAL", message: "Internal Server Error" });
}

export function createMcpApp(deps: McpAppDeps): express.Express {
  const { orchestrator: o, resource, oauthMetadata, verifier } = deps;
  const app = express();
  app.disable("x-powered-by");

  // Read API (no auth; public demo data, hashes and amounts only).
  const read = express.Router();
  read.use(cors(deps.corsOrigins));
  read.get("/health", (_req, res) => {
    res.json({ ok: true, resource: resource.href, authorizationServer: oauthMetadata.issuer, events: o.events.last()?.seq ?? 0 });
  });
  read.get("/events", (_req, res) => {
    res.json(o.events.list());
  });
  read.get("/agents", async (_req, res) => {
    try {
      res.json(jsonSafe(await o.stats.listAgents()));
    } catch (err) {
      sendError(res, err, o);
    }
  });
  read.get("/lenders", async (_req, res) => {
    try {
      res.json(jsonSafe(await o.stats.listLenders()));
    } catch (err) {
      sendError(res, err, o);
    }
  });
  read.get("/receivables/:id", async (req, res) => {
    try {
      res.json(await receivableDetails(o, String(req.params.id)));
    } catch (err) {
      sendError(res, err, o);
    }
  });
  // The invoice file itself, so anyone can hash it and compare with the registry's detailsCommitment.
  read.get("/invoices/:keccak", (req, res) => {
    try {
      const keccak = bytes32(String(req.params.keccak), "keccak");
      const meta = o.invoices.meta(keccak);
      if (!meta) throw new ToolError("NOT_FOUND", `no invoice document ${keccak}`);
      res
        .set({
          "Content-Type": meta.mime,
          "Content-Disposition": `inline; filename="${encodeURIComponent(meta.filename)}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=31536000, immutable",
        })
        .send(Buffer.from(o.invoices.bytes(meta)));
    } catch (err) {
      sendError(res, err, o);
    }
  });
  app.use(read);

  // RFC 9728 protected resource metadata (path-specific, plus the root alias some clients probe first).
  const scopesSupported = [...ALL_SCOPES];
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: resource, scopesSupported, resourceName: "CashETH MCP" }));
  if (resource.pathname !== "/") {
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json({ resource: resource.href, authorization_servers: [oauthMetadata.issuer], scopes_supported: scopesSupported, resource_name: "CashETH MCP" });
    });
  }

  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });

  app.post(resource.pathname, bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = createMcpServer(o);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      o.log("mcp request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  // Stateless server: no SSE stream to resume and no session to delete.
  app.all(resource.pathname, bearer, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  return app;
}
