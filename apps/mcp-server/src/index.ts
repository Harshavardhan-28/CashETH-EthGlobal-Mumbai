/** Boots the CashETH MCP server with the live orchestrator (`pnpm -F @casheth/mcp start`). */
import { listenHost, loadEnv, loadHederaIds } from "@casheth/shared";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { createLiveOrchestrator } from "./live.js";
import { createMcpApp } from "./server.js";

const env = loadEnv();
let ids: { hcsTopicId?: string; nftTokenId?: string } = {};
try {
  const h = loadHederaIds();
  ids = { hcsTopicId: h.hcsAuditTopicId, nftTokenId: h.receivableNftTokenId };
} catch {
  // deployments/testnet/hedera.json missing: HCS_AUDIT_TOPIC_ID / RECEIVABLE_NFT_TOKEN_ID must come from the env
}
const cfg = loadConfig(env, ids);

/** RFC 8414 metadata of the authorization server (retried while it starts). */
async function fetchAsMetadata(issuer: URL): Promise<OAuthMetadata> {
  const url = new URL("/.well-known/oauth-authorization-server", issuer);
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as OAuthMetadata;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`mcp-server: cannot read ${url.href} (${lastError instanceof Error ? lastError.message : String(lastError)}); start the auth server first`);
}

const oauthMetadata = await fetchAsMetadata(cfg.issuer);
if (oauthMetadata.issuer !== cfg.issuer.href) {
  throw new Error(`mcp-server: AUTH_ISSUER ${cfg.issuer.href} does not match the authorization server's issuer ${oauthMetadata.issuer}`);
}
const jwksUri = (oauthMetadata as { jwks_uri?: string }).jwks_uri;
const orchestrator = await createLiveOrchestrator(env, cfg);
const app = createMcpApp({
  orchestrator,
  resource: cfg.resource,
  oauthMetadata,
  verifier: createVerifier({ issuer: cfg.issuer, resource: cfg.resource, ...(jwksUri ? { jwksUri: new URL(jwksUri) } : {}) }),
  corsOrigins: cfg.corsOrigins,
});
const host = listenHost(env);
app.listen(cfg.port, host, (error?: Error) => {
  if (error) throw error;
  console.log(
    `mcp-server listening on http://${host}:${cfg.port} (resource ${cfg.resource.href}, issuer ${cfg.issuer.href}, ` +
      `HCS topic ${cfg.hcsTopicId ?? "none"}, lender keys in process ${cfg.lenderKeysInProcess}, agent keys in process ${cfg.agentKeyRoles.join(",") || "none"})`,
  );
});
