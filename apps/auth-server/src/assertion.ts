/**
 * RFC 7523 agent assertion verification (D-P7): an ES256K JWT whose `jwk` header carries the
 * agent's secp256k1 public key; `iss` must be the EVM address of that key.
 *
 * jose v6 is WebCrypto-only (no secp256k1), so the ES256K signature is checked with node:crypto;
 * jose decodes the header and payload.
 */
import { createPublicKey, verify } from "node:crypto";
import { type AgentAssertionClaims, type ErrorCode, evmAddressFromJwk, isErrorCode } from "@casheth/shared";
import { base64url, decodeJwt, decodeProtectedHeader, type JWK } from "jose";
import { getAddress, isAddress } from "viem";

/** OAuth error codes used by the token endpoint, or a CashETH error code (reported as `invalid_grant` + `code`). */
export type AuthErrorCode = ErrorCode | "invalid_request" | "invalid_grant" | "invalid_target" | "unsupported_grant_type" | "server_error";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly description: string,
  ) {
    super(`${code}: ${description}`);
    this.name = "AuthError";
  }

  /** OAuth 2.1 token error body; CashETH codes ride along in `code`. */
  toResponseObject(): { error: string; error_description: string; code?: ErrorCode } {
    if (isErrorCode(this.code)) {
      return { error: "invalid_grant", error_description: `${this.code}: ${this.description}`, code: this.code };
    }
    return { error: this.code, error_description: this.description };
  }

  get status(): number {
    return this.code === "server_error" ? 500 : 400;
  }
}

export interface VerifyAgentAssertionOptions {
  /** Accepted `aud` values (the AS issuer identifier). */
  audience: string | string[];
  /** Unix seconds; defaults to the current time. */
  now?: number;
}

const CLOCK_SKEW_SECONDS = 30;
const MAX_LIFETIME_SECONDS = 600;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function reject(description: string): never {
  throw new AuthError("invalid_grant", description);
}

function parseSecp256k1Jwk(value: unknown): JWK {
  const jwk = value as JWK | undefined;
  if (!jwk || typeof jwk !== "object") return reject("assertion header has no jwk");
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    return reject("assertion jwk must be an EC secp256k1 public key");
  }
  if ("d" in jwk) return reject("assertion jwk must not contain private key material");
  return { kty: "EC", crv: "secp256k1", x: jwk.x, y: jwk.y };
}

export async function verifyAgentAssertion(
  assertion: string,
  { audience, now }: VerifyAgentAssertionOptions,
): Promise<AgentAssertionClaims & { jwk: JWK }> {
  const parts = assertion.split(".");
  if (parts.length !== 3) reject("assertion is not a compact JWS");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: ReturnType<typeof decodeProtectedHeader>;
  let claims: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(assertion);
    claims = decodeJwt(assertion);
  } catch {
    return reject("assertion is not a decodable JWT");
  }
  if (header.alg !== "ES256K") reject("assertion alg must be ES256K");
  const jwk = parseSecp256k1Jwk(header.jwk);

  let signatureOk = false;
  try {
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    const signature = base64url.decode(encodedSignature);
    signatureOk =
      signature.length === 64 &&
      verify("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`), { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) reject("assertion signature does not verify against the header jwk");

  const { iss, sub, aud, jti, iat, exp, mandateHash, kya_evidence } = claims;
  if (typeof iss !== "string" || !isAddress(iss)) reject("assertion iss must be an EVM address");
  if (getAddress(iss as string) !== evmAddressFromJwk(jwk)) reject("assertion iss is not the address of the signing key");
  if (typeof sub !== "string" || sub.length === 0) reject("assertion sub (UAID) is required");
  if (typeof jti !== "string" || jti.length === 0) reject("assertion jti is required");
  if (typeof mandateHash !== "string" || !BYTES32.test(mandateHash)) reject("assertion mandateHash must be a bytes32 hex");
  if (kya_evidence !== undefined && typeof kya_evidence !== "string") reject("assertion kya_evidence must be a string");

  const accepted = Array.isArray(audience) ? audience : [audience];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.some((a) => typeof a === "string" && accepted.includes(a))) reject("assertion aud is not this authorization server");

  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  if (typeof exp !== "number" || typeof iat !== "number") return reject("assertion iat and exp are required");
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) reject("assertion expired");
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) reject("assertion iat is in the future");
  if (exp - iat > MAX_LIFETIME_SECONDS) reject(`assertion lifetime exceeds ${MAX_LIFETIME_SECONDS}s`);

  return {
    iss: getAddress(iss as string),
    sub: sub as string,
    aud: audiences.find((a) => typeof a === "string" && accepted.includes(a)) as string,
    jti: jti as string,
    iat,
    exp,
    mandateHash: mandateHash as `0x${string}`,
    ...(kya_evidence !== undefined ? { kya_evidence: kya_evidence as string } : {}),
    jwk,
  };
}
