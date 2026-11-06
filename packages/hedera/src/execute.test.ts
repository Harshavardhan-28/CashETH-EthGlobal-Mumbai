import { AccountId, PrecheckStatusError, Status, TransactionId, type Client } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { executeForReceipt } from "./execute.js";

const client = {} as Client;
const txId = TransactionId.withValidStart(AccountId.fromString("0.0.1001"), {
  seconds: 1_793_966_943,
  nanos: 450_939_777,
} as never);

const precheck = (status: Status) =>
  new PrecheckStatusError({ status, transactionId: txId, nodeId: AccountId.fromString("0.0.7"), contractFunctionResult: null });

describe("executeForReceipt", () => {
  it("returns the receipt of a normal submission", async () => {
    const receipt = { status: Status.Success };
    const tx = { execute: async () => ({ transactionId: txId, getReceipt: async () => receipt }) };
    const result = await executeForReceipt(client, tx as never);
    expect(result.receipt).toBe(receipt);
    expect(result.txId).toBe(txId.toString());
  });

  it("fetches the receipt by id when a retry hits DUPLICATE_TRANSACTION (the first attempt landed)", async () => {
    const receipt = { status: Status.Success };
    const asked: string[] = [];
    const tx = {
      execute: async () => {
        throw precheck(Status.DuplicateTransaction);
      },
    };
    const result = await executeForReceipt(client, tx as never, async (_c, id) => {
      asked.push(id.toString());
      return receipt as never;
    });
    expect(asked).toEqual([txId.toString()]);
    expect(result.receipt).toBe(receipt);
    expect(result.txId).toBe(txId.toString());
  });

  it("throws naming the status when the duplicate-transaction fallback fetches a failed receipt", async () => {
    const tx = {
      execute: async () => {
        throw precheck(Status.DuplicateTransaction);
      },
    };
    const failed = { status: Status.InvalidTopicId, topicSequenceNumber: null };
    await expect(executeForReceipt(client, tx as never, async () => failed as never)).rejects.toThrow(
      /INVALID_TOPIC_ID/,
    );
  });

  it("throws naming the status when the normal path's receipt is not SUCCESS", async () => {
    const failed = { status: Status.TokenHasNoSupplyKey };
    const tx = { execute: async () => ({ transactionId: txId, getReceipt: async () => failed }) };
    await expect(executeForReceipt(client, tx as never)).rejects.toThrow(/TOKEN_HAS_NO_SUPPLY_KEY/);
  });

  it("rethrows other precheck failures", async () => {
    const tx = {
      execute: async () => {
        throw precheck(Status.InsufficientPayerBalance);
      },
    };
    await expect(executeForReceipt(client, tx as never)).rejects.toThrow(/INSUFFICIENT_PAYER_BALANCE/);
  });
});
