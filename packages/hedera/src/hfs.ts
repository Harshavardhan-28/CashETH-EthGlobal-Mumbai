import { FileAppendTransaction, FileCreateTransaction, type Client } from "@hiero-ledger/sdk";
import { executeForReceipt } from "./execute.js";

/** Bytes per `FileAppend` chunk; the SDK default, well under the 6 KB transaction limit. */
export const HFS_CHUNK_BYTES = 4096;

/** Number of transactions (one create plus appends) needed to store `byteLength` bytes. */
export function hfsTransactionCount(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / HFS_CHUNK_BYTES));
}

/**
 * Stores `bytes` on the Hedera File Service: one `FileCreate` with the first chunk, then the rest as chunked
 * `FileAppend`s. The file is keyed to the operator (so only it can change or delete it) and carries `memo`.
 */
export async function storeFile(client: Client, bytes: Uint8Array, memo = ""): Promise<{ fileId: string; txIds: string[] }> {
  const operatorKey = client.operatorPublicKey;
  if (!operatorKey) throw new Error("storeFile: client has no operator");
  const create = await executeForReceipt(
    client,
    new FileCreateTransaction().setKeys([operatorKey]).setContents(bytes.subarray(0, HFS_CHUNK_BYTES)).setFileMemo(memo),
  );
  if (!create.receipt.fileId) throw new Error("File creation returned no file id");
  const fileId = create.receipt.fileId.toString();
  const txIds = [create.txId];

  if (bytes.length > HFS_CHUNK_BYTES) {
    const append = new FileAppendTransaction()
      .setFileId(fileId)
      .setContents(bytes.subarray(HFS_CHUNK_BYTES))
      .setChunkSize(HFS_CHUNK_BYTES)
      .setMaxChunks(hfsTransactionCount(bytes.length));
    for (const response of await append.executeAll(client)) {
      await response.getReceipt(client);
      txIds.push(response.transactionId.toString());
    }
  }
  return { fileId, txIds };
}
