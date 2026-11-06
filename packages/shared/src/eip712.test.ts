import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RECEIVABLE_CONFIRMATION_TYPES,
  computeReceivableId,
  hashReceivableConfirmation,
  receivableConfirmationTypedData,
  receivableDomain,
  signReceivableConfirmation,
  type ReceivableConfirmation,
} from "./eip712.js";

/** Pinned by `test_vector_hashConfirmation` in contracts/test/ReceivableRegistry.t.sol. */
const VECTOR_DIGEST = "0xa92d06494ee4362f2ede26cdd00a3a6c491fec7cdf5f3741d7240cb3f3d777e0";
const domain = receivableDomain(296, "0x4444444444444444444444444444444444444444");
const message: ReceivableConfirmation = {
  seller: "0x1111111111111111111111111111111111111111",
  buyer: "0x2222222222222222222222222222222222222222",
  currency: "0x0000000000000000000000000000000000068cDa",
  amount: 10_000_000n,
  dueDate: 1_800_000_000n,
  buyerRef: keccak256(toHex("PO-1001")),
  detailsCommitment: keccak256(toHex("doc")),
  payTo: "0x3333333333333333333333333333333333333333",
  nonce: 0n,
  deadline: 1_799_999_000n,
};

describe("ReceivableConfirmation EIP-712", () => {
  it("typed data hash equals registry hashConfirmation (pinned Solidity vector)", () => {
    expect(hashReceivableConfirmation(domain, message)).toBe(VECTOR_DIGEST);
  });

  it("types follow the Solidity struct order with uint64 dueDate/deadline", () => {
    expect(RECEIVABLE_CONFIRMATION_TYPES.ReceivableConfirmation.map((f) => `${f.type} ${f.name}`).join(",")).toBe(
      "address seller,address buyer,address currency,uint256 amount,uint64 dueDate,bytes32 buyerRef,bytes32 detailsCommitment,address payTo,uint256 nonce,uint64 deadline",
    );
    const typed = receivableConfirmationTypedData(domain, message);
    expect(typed.primaryType).toBe("ReceivableConfirmation");
    expect(typed.domain).toEqual({
      name: "AgentReceivables",
      version: "1",
      chainId: 296,
      verifyingContract: "0x4444444444444444444444444444444444444444",
    });
  });

  it("computeReceivableId is keccak256(abi.encode(buyer, buyerRef))", () => {
    const expected = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [message.buyer, message.buyerRef]),
    );
    expect(computeReceivableId(message.buyer, message.buyerRef)).toBe(expected);
  });

  it("signReceivableConfirmation recovers to the signer", async () => {
    const account = privateKeyToAccount(`0x${"0b".repeat(32)}` as Hex);
    const signed = { ...message, buyer: account.address };
    const signature = await signReceivableConfirmation(account, domain, signed);
    const recovered = await recoverTypedDataAddress({ ...receivableConfirmationTypedData(domain, signed), signature });
    expect(recovered).toBe(account.address);
  });
});
