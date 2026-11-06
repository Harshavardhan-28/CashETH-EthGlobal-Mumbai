import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@casheth/shared";
import { isAddress } from "viem";
import { loadOrCreateSigningKey } from "./keys.js";
import { createViemKyaReader } from "./kya.js";
import { createAuthApp } from "./server.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const addressesFile = `${repoRoot}deployments/testnet/addresses.json`;
const keysFile = fileURLToPath(new URL("../data/as-keys.json", import.meta.url));

function setting(env: Record<string, unknown>, key: string, fallback: string): string {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

const env = loadEnv();
if (!existsSync(addressesFile)) {
  console.error(`auth-server: ${addressesFile} not found; deploy the contracts first (it must contain the KYARegistry address).`);
  process.exit(1);
}
const addresses = JSON.parse(readFileSync(addressesFile, "utf8")) as Record<string, unknown>;
const kyaRegistry = addresses.KYARegistry ?? addresses.kyaRegistry;
if (typeof kyaRegistry !== "string" || !isAddress(kyaRegistry)) {
  console.error(`auth-server: no KYARegistry address in ${addressesFile}.`);
  process.exit(1);
}

const port = Number(setting(env, "AUTH_PORT", "4020"));
const issuer = new URL(setting(env, "AUTH_ISSUER", `http://localhost:${port}`));
const resource = new URL(setting(env, "MCP_RESOURCE_URL", "http://localhost:4030/mcp"));
const keys = await loadOrCreateSigningKey(keysFile);
const app = createAuthApp({ env, kya: createViemKyaReader(env, kyaRegistry), keys, issuer, resource });
app.listen(port, (error?: Error) => {
  if (error) throw error;
  console.log(`auth-server listening on http://localhost:${port} (issuer ${issuer.href}, resource ${resource.href}, KYARegistry ${kyaRegistry})`);
});
