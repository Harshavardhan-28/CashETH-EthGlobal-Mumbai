import {
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
  type Client,
} from "@hiero-ledger/sdk";

/**
 * Associates `tokenId` (USDC) with the account, signed by its ECDSA key, or by every key in the list
 * for a threshold-key account. Returns the transaction id.
 */
export async function associateUsdc(
  client: Client,
  accountId: string,
  privateKey: string | string[],
  tokenId: string,
): Promise<string> {
  const tx = new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([TokenId.fromString(tokenId)])
    .freezeWith(client);
  for (const key of Array.isArray(privateKey) ? privateKey : [privateKey]) {
    await tx.sign(PrivateKey.fromStringECDSA(key));
  }
  const response = await tx.execute(client);
  await response.getReceipt(client);
  return response.transactionId.toString();
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
