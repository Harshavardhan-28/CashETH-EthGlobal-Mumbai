import {
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
  type Client,
} from "@hiero-ledger/sdk";
import { executeForReceipt } from "./execute.js";

/** ECDSA key(s) as hex strings or SDK keys; every key of a threshold-key account goes in the list. */
export type SigningKeys = string | PrivateKey | (string | PrivateKey)[];

const toKeys = (keys: SigningKeys): PrivateKey[] =>
  (Array.isArray(keys) ? keys : [keys]).map((k) => (typeof k === "string" ? PrivateKey.fromStringECDSA(k) : k));

/**
 * Associates `tokenId` (USDC) with the account, signed by its ECDSA key, or by every key in the list
 * for a threshold-key account. Returns the transaction id.
 */
export async function associateUsdc(
  client: Client,
  accountId: string,
  privateKey: SigningKeys,
  tokenId: string,
): Promise<string> {
  const tx = new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([TokenId.fromString(tokenId)])
    .freezeWith(client);
  for (const key of toKeys(privateKey)) await tx.sign(key);
  return (await executeForReceipt(client, tx)).txId;
}

/**
 * Moves `units` (6-decimal base units) of `tokenId` from `from` to `to`, signed by `fromKey`, or by
 * every key in the list when `from` is a threshold-key account.
 */
export async function transferUsdc(
  client: Client,
  { tokenId, from, fromKey, to, units }: {
    tokenId: string;
    from: string;
    fromKey: string | string[];
    to: string;
    units: bigint;
  },
): Promise<string> {
  if (units <= 0n) throw new Error(`transferUsdc: units must be positive, got ${units}`);
  const tx = new TransferTransaction()
    .addTokenTransfer(tokenId, from, -units)
    .addTokenTransfer(tokenId, to, units)
    .freezeWith(client);
  for (const key of Array.isArray(fromKey) ? fromKey : [fromKey]) {
    await tx.sign(PrivateKey.fromStringECDSA(key));
  }
  const response = await tx.execute(client);
  await response.getReceipt(client);
  return response.transactionId.toString();
}
