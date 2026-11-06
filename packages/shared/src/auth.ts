/**
 * Agent auth primitives shared by agents (assertion signer) and the authorization server
 * (claims, role -> scope table). See BUILD.md section 5.2-5.3.
 *
 * ES256K note: jose v6 is WebCrypto-only and WebCrypto has no secp256k1, so the ES256K JWS
 * (RFC 8812: ECDSA P-256K over SHA-256, 64-byte r||s signature) is produced with node:crypto.
 * jose is still used for base64url and everything ES256.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { base64url, type JWK } from "jose";
import { getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type AgentAssertionClaims = {
  iss: `0x${string}`;
  sub: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  mandateHash: `0x${string}`;
  kya_evidence?: string;
};

export type AccessTokenClaims = {
  iss: string;
  sub: string;
  agent: `0x${string}`;
  role: number;
  kya_level: number;
  owner_group: `0x${string}`;
  scope: string;
  aud: string;
  jti: string;
  exp: number;
  iat: number;
};

/** Roles as stored in `KYARegistry.Agent.role`. */
export const ROLES = { Seller: 1, Buyer: 2, Worker: 3, Lender: 4 } as const;

export const READ_SCOPES = ["receivable:read", "credit:read"] as const;
/** Only granted through the auth-code path (owner grant page with the demo admin switch). */
export const AGENT_ADMIN_SCOPE = "agent:admin";

/** BUILD.md section 5.3: scopes per role at KYA level >= 2. */
export const ROLE_SCOPES: Readonly<Record<number, readonly string[]>> = {
  [ROLES.Seller]: ["receivable:write", "receivable:read", "credit:read", "facility:open", "budget:write", "spend:reserve"],
  [ROLES.Buyer]: ["receivable:confirm", "receivable:read", "credit:read", "repay:write"],
  [ROLES.Worker]: ["receivable:read", "credit:read", "spend:reserve", "spend:pay", "spend:commit"],
  [ROLES.Lender]: ["receivable:read", "credit:read"],
};

/** Every scope this system knows (for `scopes_supported`). */
export const ALL_SCOPES: readonly string[] = [...new Set([...Object.values(ROLE_SCOPES).flat(), AGENT_ADMIN_SCOPE])];

/** Role scopes filtered by KYA level: level 0 -> none, level 1 -> read scopes only, level >= 2 -> the full row. */
export function scopesForRole(role: number, level: number): string[] {
  const row = ROLE_SCOPES[role] ?? [];
  if (level < 1) return [];
  if (level === 1) return row.filter((s) => (READ_SCOPES as readonly string[]).includes(s));
  return [...row];
}

/** EVM address of a secp256k1 public JWK: keccak256(x || y)[12:], checksummed. */
export function evmAddressFromJwk(jwk: JWK): `0x${string}` {
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("expected an EC secp256k1 JWK");
  }
  const x = base64url.decode(jwk.x);
  const y = base64url.decode(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("secp256k1 JWK coordinates must be 32 bytes");
  const hash = keccak256(toHex(new Uint8Array([...x, ...y])));
  return getAddress(`0x${hash.slice(-40)}`);
}

export interface SignAgentAssertionInput {
  privateKey: `0x${string}`;
  uaid: string;
  /** The authorization server's issuer URL. */
  audience: string;
  mandateHash: `0x${string}`;
  /** Optional third-party KYA evidence (Skyfire `kya+jwt`). */
  kyaEvidence?: string;
}

const ASSERTION_TTL_SECONDS = 300;

/** RFC 7523 client assertion: an ES256K JWT signed by the agent key, carrying its public key in the `jwk` header. */
export async function signAgentAssertion(input: SignAgentAssertionInput): Promise<string> {
  const account = privateKeyToAccount(input.privateKey);
  const pub = Buffer.from(account.publicKey.slice(2), "hex"); // 0x04 || x || y
  const jwk = { kty: "EC", crv: "secp256k1", x: base64url.encode(pub.subarray(1, 33)), y: base64url.encode(pub.subarray(33)) };
  const iat = Math.floor(Date.now() / 1000);
  const claims: AgentAssertionClaims = {
    iss: account.address,
    sub: input.uaid,
    aud: input.audience,
    jti: randomUUID(),
    iat,
    exp: iat + ASSERTION_TTL_SECONDS,
    mandateHash: input.mandateHash,
    ...(input.kyaEvidence ? { kya_evidence: input.kyaEvidence } : {}),
  };
  const header = base64url.encode(JSON.stringify({ alg: "ES256K", typ: "JWT", jwk }));
  const payload = base64url.encode(JSON.stringify(claims));
  const key = createPrivateKey({ key: { ...jwk, d: base64url.encode(Buffer.from(input.privateKey.slice(2), "hex")) }, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${base64url.encode(signature)}`;
}
