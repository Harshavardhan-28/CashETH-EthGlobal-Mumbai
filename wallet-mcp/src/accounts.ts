/**
 * The keys this wallet holds, from `.env.accounts`: the seller, the buyer and the lenders. The server's own keys
 * (coordinator, co-signer, KYA issuer) and the workers' halves of their 2-of-2 spend wallets are never loaded.
 * Keys stay inside the key ring: what it lists is the role label, the Hedera account id and the EVM address.
 */
import type { Env } from "@casheth/shared";
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WalletRefusal } from "./policy.js";

export type WalletRole = "seller" | "buyer" | "lender";

/** Account label -> `.env.accounts` prefix and role. */
const WALLET_ACCOUNTS: Record<string, { prefix: string; role: WalletRole }> = {
  seller: { prefix: "SELLER", role: "seller" },
  buyer: { prefix: "BUYER", role: "buyer" },
  "lender-a": { prefix: "LENDER_A", role: "lender" },
  "lender-b": { prefix: "LENDER_B", role: "lender" },
  "lender-c": { prefix: "LENDER_C", role: "lender" },
  "lender-d": { prefix: "LENDER_D", role: "lender" },
};

export interface PublicAccount {
  account: string;
  role: WalletRole;
  accountId?: string;
  address: Address;
}

export interface HeldAccount {
  info: PublicAccount;
  signer: LocalAccount;
  /** For the viem wallet client that sends this account's transactions; never returned by a tool. */
  key: Hex;
}

export interface KeyRing {
  list(): PublicAccount[];
  /** Throws `UNKNOWN_ACCOUNT` for a label the ring does not hold. */
  get(account: string): HeldAccount;
}

function setting(env: Env, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `WALLET_ACCOUNTS` (comma-separated labels) narrows the ring; by default every account with a key is held. */
function selectedLabels(env: Env): string[] {
  const wanted = setting(env, "WALLET_ACCOUNTS");
  if (!wanted) return Object.keys(WALLET_ACCOUNTS);
  const labels = wanted.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  const unknown = labels.filter((l) => !(l in WALLET_ACCOUNTS));
  if (unknown.length) throw new Error(`WALLET_ACCOUNTS: the wallet does not hold ${unknown.join(", ")} (it can hold ${Object.keys(WALLET_ACCOUNTS).join(", ")})`);
  return Object.keys(WALLET_ACCOUNTS).filter((l) => labels.includes(l));
}

export function loadKeyRing(env: Env): KeyRing {
  const held = new Map<string, HeldAccount>();
  for (const label of selectedLabels(env)) {
    const { prefix, role } = WALLET_ACCOUNTS[label]!;
    const raw = setting(env, `${prefix}_KEY`);
    if (!raw) continue;
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    const signer = privateKeyToAccount(key);
    const accountId = setting(env, `${prefix}_ID`);
    held.set(label, { info: { account: label, role, ...(accountId ? { accountId } : {}), address: signer.address }, signer, key });
  }
  return {
    list: () => [...held.values()].map((h) => h.info),
    get(account) {
      const found = held.get(account.trim().toLowerCase());
      if (!found) throw new WalletRefusal("UNKNOWN_ACCOUNT", `unknown account "${account}" (this wallet holds ${[...held.keys()].join(", ") || "no accounts"})`);
      return found;
    },
  };
}
