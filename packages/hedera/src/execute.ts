import {
  TransactionReceiptQuery,
  type Client,
  type TransactionId,
  type TransactionReceipt,
  type TransactionResponse,
} from "@hiero-ledger/sdk";

interface Executable {
  execute(client: Client): Promise<TransactionResponse>;
}

type FetchReceipt = (client: Client, txId: TransactionId) => Promise<TransactionReceipt>;

const queryReceipt: FetchReceipt = (client, txId) =>
  new TransactionReceiptQuery().setTransactionId(txId).execute(client);

/** Duck-typed so it also matches errors from a second copy of the SDK in node_modules. */
function duplicateTxId(error: unknown): TransactionId | undefined {
  const e = error as { status?: { toString(): string }; transactionId?: TransactionId } | null;
  return e?.status?.toString() === "DUPLICATE_TRANSACTION" ? e.transactionId : undefined;
}

/**
 * Executes and waits for the receipt. When the SDK times out on a node and resubmits the same
 * transaction, the node answers DUPLICATE_TRANSACTION at precheck even though the first attempt
 * reaches consensus (observed on testnet), so in that case the receipt is fetched by id instead.
 * The transaction id is unchanged, so this never submits the operation twice.
 */
export async function executeForReceipt(
  client: Client,
  tx: Executable,
  fetchReceipt: FetchReceipt = queryReceipt,
): Promise<{ receipt: TransactionReceipt; txId: string }> {
  try {
    const response = await tx.execute(client);
    return { receipt: await response.getReceipt(client), txId: response.transactionId.toString() };
  } catch (error) {
    const txId = duplicateTxId(error);
    if (!txId) throw error;
    return { receipt: await fetchReceipt(client, txId), txId: txId.toString() };
  }
}
