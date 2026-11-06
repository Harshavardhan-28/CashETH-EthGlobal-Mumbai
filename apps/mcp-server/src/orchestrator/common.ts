import { hashscan } from "@casheth/shared";
import { getAddress, isAddress, isHex, keccak256, toHex, type Address, type Hex } from "viem";
import { fail } from "./errors.js";
import type { Caller } from "./types.js";

/** `IReceivableRegistry.State` names by enum index. */
export const STATE_NAMES = ["None", "Confirmed", "Financed", "Repaid", "Overdue", "Defaulted", "Cancelled"] as const;
export const STATE = { None: 0, Confirmed: 1, Financed: 2, Repaid: 3, Overdue: 4, Defaulted: 5, Cancelled: 6 } as const;

export const ROLE_NAMES = { 1: "seller", 2: "buyer", 3: "worker", 4: "lender" } as const;
export const ROLE_NUMBERS = { seller: 1, buyer: 2, worker: 3, lender: 4 } as const;

export const FACILITY_ACTIVE = 1;
export const RESERVATION_OPEN = 1;
/** `CreditFacility.RELEASE_GRACE`: the coordinator must commit within this window after a reservation's expiry. */
export const RELEASE_GRACE_SECONDS = 3_600n;

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function addr(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) fail("BAD_INPUT", `${field} is not an EVM address`, { field });
  return getAddress(value);
}

export function bytes32(value: string, field: string): Hex {
  if (!isHex(value) || value.length !== 66) fail("BAD_INPUT", `${field} must be a 0x-prefixed 32-byte hex string`, { field });
  return value.toLowerCase() as Hex;
}

/** A 32-byte value as-is, or the keccak256 of any other text (references that may be sensitive are hashed). */
export function bytes32OrHash(value: string): Hex {
  return isHex(value) && value.length === 66 ? (value.toLowerCase() as Hex) : keccak256(toHex(value));
}

/** Positive integer amount in token base units (USDC has 6 decimals), given as a decimal string. */
export function units(value: string, field: string, { allowZero = false } = {}): bigint {
  if (!/^\d+$/.test(value)) fail("BAD_INPUT", `${field} must be an integer amount in base units (string)`, { field });
  const n = BigInt(value);
  if (!allowZero && n === 0n) fail("ZERO_AMOUNT", `${field} must be greater than zero`, { field });
  return n;
}

export function requireParty(caller: Caller, expected: Address, what: string): void {
  if (!sameAddress(caller.agent, expected)) {
    fail("NOT_PARTY", `the caller ${caller.agent} is not the ${what} (${expected})`, { expected, caller: caller.agent });
  }
}

/** Fields every audit event carries about the caller; the UAID only when the token's `sub` is one. */
export function actor(caller: Caller): { agent: Address; agentUaid?: string; jti: string } {
  return { agent: caller.agent, ...(caller.sub.startsWith("uaid:") ? { agentUaid: caller.sub } : {}), jti: caller.jti };
}

export function txLink(txHash: string): string {
  return hashscan.tx(txHash);
}
