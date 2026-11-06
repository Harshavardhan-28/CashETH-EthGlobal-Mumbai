import { AccountCreateTransaction, Hbar, KeyList, PrivateKey, type Client, type PublicKey } from "@hiero-ledger/sdk";
import { executeForReceipt } from "./execute.js";

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

/**
 * Creates an account whose key is a `threshold`-of-n KeyList over `publicKeys`, without an EVM alias
 * (it gets the long-zero EVM address). Every transaction it pays or sends needs `threshold` signatures.
 */
export async function createThresholdAccount(
  client: Client,
  { publicKeys, threshold, initialHbar, label }: {
    publicKeys: PublicKey[];
    threshold: number;
    initialHbar: number;
    label: string;
  },
): Promise<{ accountId: string; txId: string }> {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > publicKeys.length) {
    throw new Error(`createThresholdAccount: threshold ${threshold} must be 1..${publicKeys.length}`);
  }
  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(new KeyList(publicKeys, threshold))
    .setInitialBalance(new Hbar(initialHbar))
    .setMaxAutomaticTokenAssociations(10)
    .setAccountMemo(`casheth:${label}`);
  const { receipt, txId } = await executeForReceipt(client, tx);
  if (!receipt.accountId) throw new Error(`Account creation for ${label} returned no account id`);
  return { accountId: receipt.accountId.toString(), txId };
}
