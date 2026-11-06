import { AccountCreateTransaction, Hbar, PrivateKey, type Client } from "@hiero-ledger/sdk";

export interface CreatedAccount {
  accountId: string;
  evmAddress: `0x${string}`;
  privateKey: `0x${string}`;
  txId: string;
}

/**
 * Creates an account whose key is a fresh ECDSA key with the derived EVM address as alias, so
 * Solidity sees that address as msg.sender. The operator of `client` pays.
 */
export async function createEcdsaAccount(
  client: Client,
  { initialHbar, label }: { initialHbar: number; label: string },
): Promise<CreatedAccount> {
  const key = PrivateKey.generateECDSA();
  const response = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(new Hbar(initialHbar))
    .setMaxAutomaticTokenAssociations(10)
    .setAccountMemo(`casheth:${label}`)
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (!receipt.accountId) throw new Error(`Account creation for ${label} returned no account id`);
  return {
    accountId: receipt.accountId.toString(),
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    privateKey: `0x${key.toStringRaw()}`,
    txId: response.transactionId.toString(),
  };
}
