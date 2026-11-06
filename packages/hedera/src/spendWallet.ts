import type { Env } from "@casheth/shared";
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  type Client,
  type PrivateKey,
  type PublicKey,
  type Transaction,
} from "@hiero-ledger/sdk";
import { createThresholdAccount } from "./accounts.js";
import { executeForReceipt } from "./execute.js";
import { mirror } from "./mirror.js";
import { associateUsdc } from "./tokens.js";

/** HTS allowance amounts are int64; the SDK silently wraps 2^63 and above into a negative Long. */
const MAX_INT64 = 2n ** 63n - 1n;

export interface SpendWallet {
  accountId: string;
  /** Long-zero EVM address (no alias): `0x` + the 20-byte account number. */
  evmAddress: `0x${string}`;
  txId: string;
}

/** Long-zero EVM address of an account created without an alias (what the mirror node reports). */
export function longZeroEvmAddress(accountId: string): `0x${string}` {
  return `0x${AccountId.fromString(accountId).toEvmAddress()}`;
}

/**
 * Creates a worker's spend wallet: key `KeyList([worker, cosigner], 2)` without an EVM alias, so any
 * transaction it sends needs both the worker's and the policy co-signer's signature. The operator of
 * `client` pays and funds `initialHbar`; up to 10 tokens may auto-associate.
 */
export async function createSpendWallet(
  client: Client,
  { workerPub, cosignerPub, initialHbar, label }: {
    workerPub: PublicKey;
    cosignerPub: PublicKey;
    initialHbar: number;
    label: string;
  },
): Promise<SpendWallet> {
  const { accountId, txId } = await createThresholdAccount(client, {
    publicKeys: [workerPub, cosignerPub],
    threshold: 2,
    initialHbar,
    label,
  });
  return { accountId, evmAddress: longZeroEvmAddress(accountId), txId };
}

/** Associates USDC with the spend wallet; `keys` must satisfy its KeyList (worker and co-signer). */
export function associateSpendWalletUsdc(
  client: Client,
  { accountId, keys, tokenId }: { accountId: string; keys: PrivateKey[]; tokenId: string },
): Promise<string> {
  return associateUsdc(client, accountId, keys, tokenId);
}

/** Contract entity id (`0.0.x`) of the contract at `evmAddress`, from the mirror node. */
export async function resolveContractId(env: Env, evmAddress: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) throw new Error(`resolveContractId: not an EVM address: ${evmAddress}`);
  const body = await mirror.contract(env, evmAddress);
  const id = body.contract_id;
  if (typeof id !== "string" || !/^\d+\.\d+\.\d+$/.test(id)) {
    throw new Error(`resolveContractId: mirror response for ${evmAddress} has no contract_id`);
  }
  return id;
}

export interface FacilityAllowance {
  walletId: string;
  tokenId: string;
  /** The facility's CONTRACT id (`0.0.x`), not its EVM address; see `resolveContractId`. */
  spenderContractId: string;
  /** Token base units; HTS allowances are int64, so at most 2^63 - 1. */
  units: bigint;
}

/** Unfrozen `AccountAllowanceApproveTransaction` granting `spenderContractId` `units` of the wallet's token. */
export function facilityAllowanceTx({
  walletId,
  tokenId,
  spenderContractId,
  units,
}: FacilityAllowance): AccountAllowanceApproveTransaction {
  if (units < 0n) throw new Error(`facility allowance: units must not be negative, got ${units}`);
  if (units > MAX_INT64) {
    throw new Error(`facility allowance: ${units} exceeds the int64 HTS allowance limit ${MAX_INT64}`);
  }
  return new AccountAllowanceApproveTransaction().approveTokenAllowance(tokenId, walletId, spenderContractId, units);
}

/** Signs a frozen transaction with every key, in order. */
export async function signWithAll<T extends Transaction>(tx: T, keys: PrivateKey[]): Promise<T> {
  for (const key of keys) await tx.sign(key);
  return tx;
}

type Execute = (client: Client, tx: Transaction) => Promise<{ txId: string }>;

/**
 * Grants the facility contract a standing allowance over the spend wallet's tokens. The operator of
 * `client` pays the fee; the wallet, as owner, signs with all of `keys` (worker and co-signer).
 */
export async function approveFacilityAllowance(
  client: Client,
  { keys, ...allowance }: FacilityAllowance & { keys: PrivateKey[] },
  execute: Execute = executeForReceipt,
): Promise<string> {
  if (keys.length === 0) throw new Error("approveFacilityAllowance: no signing keys");
  const tx = facilityAllowanceTx(allowance).freezeWith(client);
  await signWithAll(tx, keys);
  return (await execute(client, tx)).txId;
}

export type MirrorKeyType = "ECDSA_SECP256K1" | "ED25519";

export interface DecodedKey {
  threshold: number;
  keys: { type: MirrorKeyType; publicKey: string }[];
}

/** Minimal protobuf reader for the `Key` / `ThresholdKey` / `KeyList` messages (basic_types.proto). */
function fields(bytes: Uint8Array): { field: number; varint?: number; bytes?: Uint8Array }[] {
  const out: { field: number; varint?: number; bytes?: Uint8Array }[] = [];
  let i = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= bytes.length || shift > 28) throw new Error("decodeMirrorKey: bad varint");
      const b = bytes[i++]!;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value >>> 0;
    }
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ field, varint: varint() });
    else if (wire === 2) {
      const len = varint();
      if (i + len > bytes.length) throw new Error("decodeMirrorKey: truncated field");
      out.push({ field, bytes: bytes.subarray(i, i + len) });
      i += len;
    } else throw new Error(`decodeMirrorKey: unsupported wire type ${wire}`);
  }
  return out;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** A simple (non-list) protobuf `Key`: field 2 = ed25519, field 7 = ECDSA_secp256k1. */
function simpleKey(bytes: Uint8Array): { type: MirrorKeyType; publicKey: string } {
  const [f, ...rest] = fields(bytes);
  if (!f?.bytes || rest.length) throw new Error("decodeMirrorKey: expected exactly one key field");
  if (f.field === 7) return { type: "ECDSA_SECP256K1", publicKey: hex(f.bytes) };
  if (f.field === 2) return { type: "ED25519", publicKey: hex(f.bytes) };
  throw new Error(`decodeMirrorKey: unsupported nested key field ${f.field}`);
}

/**
 * Reads the `key` of a mirror-node account. Single keys come back typed (`ECDSA_SECP256K1`,
 * `ED25519`); a threshold key comes back as `{ _type: "ProtobufEncoded", key: <hex of proto Key> }`,
 * decoded here into its threshold and flat list of simple keys (nested lists are rejected).
 */
export function decodeMirrorKey(key: { _type: string; key: string }): DecodedKey {
  if (key._type === "ECDSA_SECP256K1" || key._type === "ED25519") {
    return { threshold: 1, keys: [{ type: key._type, publicKey: key.key }] };
  }
  if (key._type !== "ProtobufEncoded") throw new Error(`decodeMirrorKey: unsupported key type ${key._type}`);
  const [top, ...extra] = fields(Uint8Array.from(Buffer.from(key.key, "hex")));
  if (!top?.bytes || extra.length) throw new Error("decodeMirrorKey: expected one top-level key");
  const listKeys = (list: Uint8Array) =>
    fields(list).map((f) => {
      if (f.field !== 1 || !f.bytes) throw new Error("decodeMirrorKey: malformed KeyList");
      return simpleKey(f.bytes);
    });
  if (top.field === 6) {
    const keys = listKeys(top.bytes);
    return { threshold: keys.length, keys };
  }
  if (top.field !== 5) return { threshold: 1, keys: [simpleKey(Buffer.from(key.key, "hex"))] };
  let threshold: number | undefined;
  let keys: DecodedKey["keys"] = [];
  for (const f of fields(top.bytes)) {
    if (f.field === 1 && f.varint !== undefined) threshold = f.varint;
    else if (f.field === 2 && f.bytes) keys = listKeys(f.bytes);
    else throw new Error(`decodeMirrorKey: unexpected ThresholdKey field ${f.field}`);
  }
  if (threshold === undefined) throw new Error("decodeMirrorKey: ThresholdKey without a threshold");
  return { threshold, keys };
}
