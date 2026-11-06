/** The AS access-token signing key: ES256 (P-256), generated once and persisted as JWK JSON (mode 0600). */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { calculateJwkThumbprint, type CryptoKey, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export const ACCESS_TOKEN_ALG = "ES256";

/** jose v6 has no `KeyLike`; the private key is a WebCrypto `CryptoKey`. */
export interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

interface StoredKeys {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

export async function loadOrCreateSigningKey(filePath: string): Promise<SigningKey> {
  let stored: StoredKeys;
  if (existsSync(filePath)) {
    stored = JSON.parse(await readFile(filePath, "utf8")) as StoredKeys;
  } else {
    const { privateKey } = await generateKeyPair(ACCESS_TOKEN_ALG, { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const { d: _d, ...publicPart } = privateJwk;
    const kid = await calculateJwkThumbprint(publicPart);
    stored = {
      kid,
      privateJwk: { ...privateJwk, alg: ACCESS_TOKEN_ALG, kid },
      publicJwk: { ...publicPart, alg: ACCESS_TOKEN_ALG, use: "sig", kid },
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(filePath, 0o600);
  }
  const privateKey = (await importJWK(stored.privateJwk, ACCESS_TOKEN_ALG)) as CryptoKey;
  return { privateKey, publicJwk: stored.publicJwk, kid: stored.kid };
}
