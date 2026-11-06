import {
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
  type Client,
} from "@hiero-ledger/sdk";

/** Associates `tokenId` (USDC) with the account, signed by its ECDSA key. Returns the transaction id. */
export async function associateUsdc(
  client: Client,
  accountId: string,
  privateKey: string,
  tokenId: string,
): Promise<string> {
  const tx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([TokenId.fromString(tokenId)])
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(privateKey));
  const response = await tx.execute(client);
  await response.getReceipt(client);
  return response.transactionId.toString();
}

/** Moves `units` (6-decimal base units) of `tokenId` from `from` to `to`, signed by `fromKey`. */
export async function transferUsdc(
  client: Client,
  { tokenId, from, fromKey, to, units }: {
    tokenId: string;
    from: string;
    fromKey: string;
    to: string;
    units: bigint;
  },
): Promise<string> {
  if (units <= 0n) throw new Error(`transferUsdc: units must be positive, got ${units}`);
  const tx = await new TransferTransaction()
    .addTokenTransfer(tokenId, from, -units)
    .addTokenTransfer(tokenId, to, units)
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(fromKey));
  const response = await tx.execute(client);
  await response.getReceipt(client);
  return response.transactionId.toString();
}
