/** Uploaded receivables awaiting the buyer's EIP-712 confirmation, persisted as one JSON file. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";

export type PendingReceivable = {
  pendingId: Hex;
  /** `keccak256(abi.encode(buyer, buyerRef))`, the id the registry will assign. */
  id: Hex;
  seller: Address;
  buyer: Address;
  currency: Address;
  amount: string;
  dueDate: string;
  buyerRef: Hex;
  detailsCommitment: Hex;
  payTo: Address;
  nonce: string;
  deadline: string;
  chainId: number;
  verifyingContract: Address;
  createdAt: string;
};

export class PendingStore {
  readonly #filePath: string | undefined;
  readonly #items: Record<string, PendingReceivable>;

  /** In-memory only when `filePath` is undefined. */
  constructor(filePath?: string) {
    this.#filePath = filePath;
    this.#items =
      filePath && existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, PendingReceivable>) : {};
  }

  get(pendingId: string): PendingReceivable | undefined {
    return this.#items[pendingId.toLowerCase()];
  }

  byReceivableId(id: string): PendingReceivable | undefined {
    return Object.values(this.#items).find((p) => p.id.toLowerCase() === id.toLowerCase());
  }

  put(item: PendingReceivable): void {
    this.#items[item.pendingId.toLowerCase()] = item;
    if (!this.#filePath) return;
    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, `${JSON.stringify(this.#items, null, 2)}\n`);
  }
}
