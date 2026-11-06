import { getAddress, maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { checkCalls, checkConfirmation, WalletRefusal } from "./policy.js";
import { ADDRESSES, approve, BUYER, dock, repay, SELLER, transfer, uploadResult } from "./test/fixtures.js";

const CAP = 20_000_000n;
const OTHER = getAddress("0x00000000000000000000000000000000000000e1");
const typedData = (overrides?: Parameters<typeof uploadResult>[0]) => uploadResult(overrides).confirmationRequest.typedData;

function refusal(run: () => void): WalletRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof WalletRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("checkConfirmation", () => {
  const ctx = { addresses: ADDRESSES, signer: BUYER.address };

  it("accepts the ReceivableRegistry's confirmation for the signing buyer, paid to the RepaymentRouter in USDC", () => {
    expect(() => checkConfirmation(typedData(), ctx)).not.toThrow();
  });

  it("refuses typed data for another verifying contract", () => {
    expect(refusal(() => checkConfirmation(typedData({ domain: { verifyingContract: OTHER } }), ctx)).code).toBe("WRONG_DOMAIN");
  });

  it("refuses another domain name, version or chain", () => {
    expect(refusal(() => checkConfirmation(typedData({ domain: { name: "Permit" } }), ctx)).code).toBe("WRONG_DOMAIN");
    expect(refusal(() => checkConfirmation(typedData({ domain: { version: "2" } }), ctx)).code).toBe("WRONG_DOMAIN");
    expect(refusal(() => checkConfirmation(typedData({ domain: { chainId: 1 } }), ctx)).code).toBe("WRONG_DOMAIN");
  });

  it("refuses a confirmation that names another buyer than the signing account", () => {
    expect(refusal(() => checkConfirmation(typedData(), { ...ctx, signer: SELLER.address })).code).toBe("SIGNER_NOT_BUYER");
  });

  it("refuses a confirmation that pays anyone but the RepaymentRouter, or in another currency", () => {
    expect(refusal(() => checkConfirmation(typedData({ message: { payTo: OTHER } }), ctx)).code).toBe("WRONG_PAYEE");
    expect(refusal(() => checkConfirmation(typedData({ message: { currency: OTHER } }), ctx)).code).toBe("WRONG_CURRENCY");
  });
});

describe("checkCalls", () => {
  const ctx = { addresses: ADDRESSES, approveCap: CAP };

  it("accepts repay_receivable's exact approval and repayment, and an Aqua dock", () => {
    expect(() => checkCalls([approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, 2_000_000n), repay(2_000_000n), dock()], ctx)).not.toThrow();
  });

  it("refuses a target outside USDC, tUSDT, the RepaymentRouter and Aqua", () => {
    const toFacility = { ...repay(1n), to: ADDRESSES.creditFacility! };
    const error = refusal(() => checkCalls([toFacility], ctx));
    expect(error.code).toBe("TARGET_NOT_ALLOWED");
    expect(error.details).toMatchObject({ index: 0, to: ADDRESSES.creditFacility });
  });

  it("refuses an unlimited approval", () => {
    expect(refusal(() => checkCalls([approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, maxUint256)], ctx)).code).toBe("APPROVE_UNLIMITED");
  });

  it("refuses an approval above the per-call cap", () => {
    const error = refusal(() => checkCalls([approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, CAP + 1n)], ctx));
    expect(error.code).toBe("APPROVE_ABOVE_CAP");
    expect(error.details).toMatchObject({ amount: (CAP + 1n).toString(), cap: CAP.toString() });
  });

  it("refuses an approval to a spender that is not the RepaymentRouter or Aqua", () => {
    expect(refusal(() => checkCalls([approve(ADDRESSES.usdc!, OTHER, 1n)], ctx)).code).toBe("SPENDER_NOT_ALLOWED");
  });

  it("refuses a token transfer: tokens may only be approved to the protocol", () => {
    expect(refusal(() => checkCalls([transfer(OTHER, 1n)], ctx)).code).toBe("FUNCTION_NOT_ALLOWED");
  });

  it("refuses calldata an allowlisted contract does not decode", () => {
    expect(refusal(() => checkCalls([{ to: ADDRESSES.repaymentRouter!, data: "0xdeadbeef", description: "?" }], ctx)).code).toBe("FUNCTION_NOT_ALLOWED");
  });

  it("checks every call before any is sent: a bad last call refuses the whole batch", () => {
    const error = refusal(() => checkCalls([approve(ADDRESSES.usdc!, ADDRESSES.repaymentRouter!, 1n), transfer(OTHER, 1n)], ctx));
    expect(error.details).toMatchObject({ index: 1 });
  });

  it("refuses an empty batch", () => {
    expect(refusal(() => checkCalls([], ctx)).code).toBe("BAD_INPUT");
  });
});
