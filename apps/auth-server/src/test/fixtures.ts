/** Test-only helpers (excluded from the build). */
import { createPrivateKey, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Env, loadEnv } from "@casheth/shared";
import { base64url } from "jose";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type AgentRecord, InMemoryKyaReader } from "../kya.js";
import { loadOrCreateSigningKey } from "../keys.js";
import { createAuthApp } from "../server.js";

export const ISSUER = new URL("http://localhost:4020");
export const RESOURCE = new URL("http://localhost:4030/mcp");
export const MANDATE = keccak256(toHex("mandate:v1"));

export function testEnv(extra: Record<string, string> = {}): Env {
  return loadEnv({
    source: {
      HEDERA_NETWORK: "testnet",
      HEDERA_CHAIN_ID: "296",
      HEDERA_JSON_RPC_URL: "https://testnet.hashio.io/api",
      HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
      HEDERA_OPERATOR_ID: "0.0.1001",
      HEDERA_OPERATOR_KEY: "0xoperator",
      MERCHANT_ACCOUNT_ID: "0.0.1002",
      MERCHANT_KEY: "0xmerchant",
      USDC_TOKEN_ID: "0.0.429274",
      USDC_EVM_ADDRESS: "0x0000000000000000000000000000000000068cda",
      X402_FACILITATOR_URL: "https://facilitator.example",
      X402_NETWORK: "hedera-testnet",
      ...extra,
    },
  });
}

export async function tempKeys() {
  const dir = await mkdtemp(join(tmpdir(), "casheth-as-"));
  return loadOrCreateSigningKey(join(dir, "as-keys.json"));
}

export interface TestAgent {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  uaid: string;
  record: AgentRecord;
}

/** A fresh agent key plus a matching KYA record (registered in `kya` when given). */
export function newAgent(role: number, level: number, overrides: Partial<AgentRecord> = {}, kya?: InMemoryKyaReader): TestAgent {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  const uaid = `uaid:aid:${address.slice(2, 10)}`;
  const record: AgentRecord = {
    uaidHash: keccak256(toHex(uaid)),
    ownerGroup: keccak256(toHex("owner:acme")),
    role,
    level,
    expiresAt: 0n,
    revoked: false,
    mandateHash: MANDATE,
    ...overrides,
  };
  kya?.set(address, record);
  return { privateKey, address, uaid, record };
}

/** Signs arbitrary claims as an ES256K JWT with `privateKey`, embedding its public JWK (for forging bad assertions). */
export function signRawAssertion(privateKey: `0x${string}`, claims: Record<string, unknown>): string {
  const pub = Buffer.from(privateKeyToAccount(privateKey).publicKey.slice(2), "hex");
  const jwk = { kty: "EC", crv: "secp256k1", x: base64url.encode(pub.subarray(1, 33)), y: base64url.encode(pub.subarray(33)) };
  const header = base64url.encode(JSON.stringify({ alg: "ES256K", typ: "JWT", jwk }));
  const payload = base64url.encode(JSON.stringify(claims));
  const key = createPrivateKey({ key: { ...jwk, d: base64url.encode(Buffer.from(privateKey.slice(2), "hex")) }, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${base64url.encode(signature)}`;
}

export async function testApp(envExtra: Record<string, string> = {}) {
  const kya = new InMemoryKyaReader();
  const keys = await tempKeys();
  const app = createAuthApp({ env: testEnv(envExtra), kya, keys, issuer: ISSUER, resource: RESOURCE });
  return { app, kya, keys };
}
