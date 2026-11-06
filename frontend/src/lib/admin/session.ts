// Server-side only: imports node:crypto and reads secrets from process.env.
// Never import this from a client component.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "casheth_admin";
export const SESSION_MAX_AGE = 43200; // 12 hours, in seconds

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time compare of two strings of any length. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function checkPassword(input: string): boolean {
  return safeEqual(input, process.env.ADMIN_PASSWORD || "admin@01");
}

/** Deterministic session value: HMAC of a fixed label under the server secret. */
export function sessionToken(): string {
  const secret = process.env.ADMIN_SESSION_SECRET || "casheth-demo-admin-secret";
  return createHmac("sha256", secret).update("casheth-admin-v1").digest("hex");
}

export function isValidSession(value: string | undefined): boolean {
  if (!value) return false;
  return safeEqual(value, sessionToken());
}

/** Options shared by the login (set) and logout (clear) cookie writes. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
