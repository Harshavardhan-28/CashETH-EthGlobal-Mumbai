import {
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  type Client,
} from "@hiero-ledger/sdk";
import { executeForReceipt } from "./execute.js";

/** HTS caps NFT metadata at 100 bytes. */
export const MAX_NFT_METADATA_BYTES = 100;

/** Creates the receivable NFT collection; the operator is treasury and holds the supply key. */
export async function createReceivableCollection(
  client: Client,
  { name, symbol }: { name: string; symbol: string } = { name: "CashETH Receivable", symbol: "CRCV" },
): Promise<{ tokenId: string; txId: string }> {
  const operatorId = client.operatorAccountId;
  const operatorKey = client.operatorPublicKey;
  if (!operatorId || !operatorKey) throw new Error("createReceivableCollection: client has no operator");
  const tx = new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setDecimals(0)
    .setInitialSupply(0)
    .setTreasuryAccountId(operatorId)
    .setSupplyKey(operatorKey)
    .setTokenMemo("CashETH receivable handles; metadata = {id, seq}");
  const { receipt, txId } = await executeForReceipt(client, tx);
  if (!receipt.tokenId) throw new Error("Token creation returned no token id");
  return { tokenId: receipt.tokenId.toString(), txId };
}

/** UTF-8 of `{"id":…,"seq":…}`: the on-chain receivable id plus the HCS sequence that recorded it. */
export function encodeReceivableMetadata({ id, hcsSeq }: { id: string; hcsSeq: number }): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify({ id, seq: hcsSeq }));
  if (bytes.length > MAX_NFT_METADATA_BYTES) {
    throw new Error(
      `Receivable NFT metadata is ${bytes.length} bytes; HTS allows at most ${MAX_NFT_METADATA_BYTES} bytes`,
    );
  }
  return bytes;
}

type SerialLike = number | bigint | { toNumber(): number };

/** First minted serial from a mint receipt (`receipt.serials` holds Long values in the Hiero SDK). */
export function serialFromReceipt(receipt: { serials: readonly SerialLike[] }): number {
  const serial = receipt.serials[0];
  if (serial === undefined) throw new Error("Mint receipt carries no serial");
  if (typeof serial === "number") return serial;
  if (typeof serial === "bigint") return Number(serial);
  return serial.toNumber();
}

/** Mints one receivable NFT to the treasury (the operator), signed by the operator's supply key. */
export async function mintReceivableNft(
  client: Client,
  tokenId: string,
  { id, hcsSeq }: { id: string; hcsSeq: number },
): Promise<{ serial: number; txId: string }> {
  const { receipt, txId } = await executeForReceipt(
    client,
    new TokenMintTransaction().setTokenId(tokenId).setMetadata([encodeReceivableMetadata({ id, hcsSeq })]),
  );
  return { serial: serialFromReceipt(receipt), txId };
}
